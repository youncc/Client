import { Plugin, SettingsTypes, PanelManager } from '@camelkit/core';
import { DEFAULT_GPU_SETTINGS, GpuRendering, isRenderGame, normalizeGpuSettings } from '../helpers/gpuRendering';
import type { GpuSettings } from '../helpers/gpuRendering';

export default class GpuPlugin extends Plugin {
    pluginName = 'GPU';
    author = 'CamelKit';
    version = '0.1.0';

    private panelManager = new PanelManager();
    private panel: HTMLElement | null = null;
    private rendering: GpuRendering | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private changeTimer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private failedGame: unknown = null;

    constructor() {
        super();
        this.settings.drawDistance = {
            text: 'Draw distance (tiles)', type: SettingsTypes.range,
            description: 'Farther views load more scenery. Low GPU mode retains its native distance cap.',
            value: 72, min: 24, max: 128, callback: () => this.settingsChanged(),
        };
        this.settings.fogMode = {
            text: 'Fog mode', type: SettingsTypes.combobox,
            value: 'Custom', options: ['Game', 'Custom', 'Off'], callback: () => this.settingsChanged(),
        };
        this.settings.fogStart = {
            text: 'Fog start (% of draw distance)', type: SettingsTypes.range,
            value: 65, min: 0, max: 95, callback: () => this.settingsChanged(),
        };
        this.settings.fogEnd = {
            text: 'Fog end (% of draw distance)', type: SettingsTypes.range,
            value: 100, min: 5, max: 100, callback: () => this.settingsChanged(),
        };
    }

    init(): void { this.readSettings(); }

    start(): void {
        if (this.running) return;
        this.running = true;
        const [icon, panel] = this.panelManager.requestMenuItem('🖥️', 'GPU');
        icon.title = 'GPU';
        icon.setAttribute('role', 'button');
        icon.setAttribute('aria-label', 'GPU');
        icon.tabIndex = 0;
        icon.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                icon.click();
            }
        });
        this.panel = panel;
        this.renderPanel();
        this.attachGame();
        this.timer = setInterval(() => this.attachGame(), 500);
    }

    stop(): void {
        this.running = false;
        if (this.timer !== null) clearInterval(this.timer);
        if (this.changeTimer !== null) clearTimeout(this.changeTimer);
        this.timer = this.changeTimer = null;
        this.releaseGame();
        this.failedGame = null;
        this.panelManager.removeMenuItem('🖥️');
        this.panel = null;
    }

    private readSettings(): GpuSettings {
        const settings = normalizeGpuSettings({
            drawDistance: Number(this.settings.drawDistance.value),
            fogMode: this.settings.fogMode.value as GpuSettings['fogMode'],
            fogStart: Number(this.settings.fogStart.value),
            fogEnd: Number(this.settings.fogEnd.value),
        });
        for (const key of Object.keys(settings) as Array<keyof GpuSettings>) this.settings[key].value = settings[key];
        return settings;
    }

    private settingsChanged(): void {
        const settings = this.readSettings();
        this.syncControls(settings);
        if (this.changeTimer !== null) clearTimeout(this.changeTimer);
        // Coalesce slider input so dragging does not repeatedly restart streaming.
        this.changeTimer = setTimeout(() => {
            this.changeTimer = null;
            if (!this.running) return;
            try {
                this.rendering?.setSettings(settings);
                this.updateStatus();
            } catch (error) {
                this.warn('Could not apply GPU settings:', error);
                this.releaseGame();
                this.setStatus('Waiting to reconnect to the game renderer…');
            }
        }, 150);
    }

    private attachGame(): void {
        if (!this.running) return;
        const hooks = this.gameHooks as any;
        const game = hooks?.GameManager?.Instance ?? (window as any).gm;
        // Login/map bootstrap must finish with the game's unmodified loader.
        // Chunk failures during this phase can become available as loading proceeds.
        if (game && (game.localPlayer === null || game.loginBootstrap?.settled === false || game.activeMapChangeSeq > 0)) {
            this.releaseGame();
            this.setStatus('Waiting for the world to finish loading…');
            return;
        }
        if (this.rendering && this.rendering.game === game && !game.destroyed) {
            this.updateStatus();
            return;
        }
        this.releaseGame();
        if (!isRenderGame(game)) {
            this.setStatus('Waiting for the game renderer…');
            return;
        }
        if (game === this.failedGame) return;
        try {
            this.rendering = new GpuRendering(game, this.readSettings());
            this.info(`Map chunk retry guard: ${this.rendering.guardingMissingChunks ? 'active' : 'unavailable for this renderer'}`);
            this.failedGame = null;
            this.updateStatus();
        } catch (error) {
            this.failedGame = game;
            this.warn('Could not attach GPU controls:', error);
            this.setStatus('This game renderer is not supported. Native settings are retained.');
        }
    }

    private releaseGame(): void {
        this.rendering?.dispose();
        this.rendering = null;
    }

    private setStatus(message: string): void {
        const status = this.panel?.querySelector<HTMLElement>('[data-gpu-status]');
        if (status && status.textContent !== message) status.textContent = message;
    }

    private updateStatus(): void {
        if (!this.rendering) return;
        const distance = this.rendering.distance;
        const requested = Number(this.settings.drawDistance.value);
        const base = distance < requested
            ? `Low GPU mode limits the view to ${distance} tiles (selected: ${requested}).`
            : `Draw distance: ${distance} tiles. Fog: ${this.settings.fogMode.value}.`;
        const missing = this.rendering.missingChunks;
        this.setStatus(missing ? `${base} ${missing} map chunks are unavailable; automatic retries are paused for this map version.` : base);
        const retry = this.panel?.querySelector<HTMLButtonElement>('[data-gpu-retry]');
        if (retry) retry.hidden = missing === 0;
    }

    private syncControls(settings: GpuSettings): void {
        if (!this.panel) return;
        for (const key of ['drawDistance', 'fogStart', 'fogEnd'] as const) {
            for (const input of this.panel.querySelectorAll<HTMLInputElement>(`[data-setting="${key}"]`)) {
                input.value = String(settings[key]);
                input.disabled = key !== 'drawDistance' && settings.fogMode !== 'Custom';
            }
        }
        const select = this.panel.querySelector<HTMLSelectElement>('select');
        if (select) select.value = settings.fogMode;
    }

    private renderPanel(): void {
        if (!this.panel) return;
        this.panel.classList.add('camelkit-gpu-panel');
        this.panel.style.width = '100%';
        this.panel.innerHTML = `
            <style>
                .camelkit-gpu-panel { box-sizing:border-box; padding:14px; background:var(--theme-background); color:var(--theme-text-primary); font:13px/1.5 Inter,system-ui,sans-serif; }
                .camelkit-gpu-panel h3 { margin:0 0 8px; }
                .camelkit-gpu-panel p,.camelkit-gpu-panel small { color:var(--theme-text-muted); }
                .camelkit-gpu-panel .gpu-control { margin:18px 0; }
                .camelkit-gpu-panel label { font-weight:600; }
                .camelkit-gpu-panel .gpu-row { display:flex; align-items:center; gap:8px; margin-top:6px; }
                .camelkit-gpu-panel input[type=range] { min-width:0; flex:1; accent-color:var(--theme-accent,#b99d65); }
                .camelkit-gpu-panel input[type=number] { width:52px; }
                .camelkit-gpu-panel input[type=number],.camelkit-gpu-panel select,.camelkit-gpu-panel button { padding:6px; border:1px solid var(--theme-border); border-radius:4px; background:var(--theme-background-mute); color:var(--theme-text-primary); }
                .camelkit-gpu-panel select,.camelkit-gpu-panel button { width:100%; }
                .camelkit-gpu-panel button { margin-top:8px; cursor:pointer; }
                .camelkit-gpu-panel input:disabled { opacity:.45; }
            </style>
            <h3>Draw distance &amp; fog</h3>
            <p>See more of the world with an extended camera view.</p>
            <div class="gpu-controls"></div>
            <div class="gpu-control"><label for="camelkit-gpu-fog">Fog mode</label>
                <div class="gpu-row"><select id="camelkit-gpu-fog" aria-label="Fog mode">
                    <option>Game</option><option>Custom</option><option>Off</option>
                </select></div>
            </div>
            <div class="gpu-fog-controls"></div>
            <small>Fog percentages are relative to draw distance. Higher draw distances use more graphics power and memory. Scenery may take a moment to load.</small>
            <button type="button">Reset GPU settings</button>
            <button type="button" data-gpu-retry hidden>Retry unavailable map chunks</button>
            <p role="status" data-gpu-status></p>
        `;
        this.addControl('drawDistance', 'Draw distance', 24, 128, 'tiles', '.gpu-controls');
        this.addControl('fogStart', 'Fog start', 0, 95, '%', '.gpu-fog-controls');
        this.addControl('fogEnd', 'Fog end', 5, 100, '%', '.gpu-fog-controls');
        this.panel.querySelector('select')!.addEventListener('change', event => {
            this.settings.fogMode.value = (event.target as HTMLSelectElement).value;
            this.settingsChanged();
        });
        this.panel.querySelector('button')!.addEventListener('click', () => {
            for (const key of Object.keys(DEFAULT_GPU_SETTINGS) as Array<keyof GpuSettings>) {
                this.settings[key].value = DEFAULT_GPU_SETTINGS[key];
            }
            this.settingsChanged();
        });
        this.panel.querySelector('[data-gpu-retry]')!.addEventListener('click', () => {
            this.rendering?.retryMissingChunks();
            this.updateStatus();
        });
        this.syncControls(this.readSettings());
    }

    private addControl(key: 'drawDistance' | 'fogStart' | 'fogEnd', title: string, min: number, max: number, unit: string, target: string): void {
        const group = document.createElement('div');
        group.className = 'gpu-control';
        group.innerHTML = `<label for="camelkit-gpu-${key}">${title}</label><div class="gpu-row">
            <input id="camelkit-gpu-${key}" type="range" data-setting="${key}" min="${min}" max="${max}" step="1">
            <input type="number" aria-label="${title} ${unit}" data-setting="${key}" min="${min}" max="${max}" step="1"><span>${unit}</span>
        </div>`;
        for (const input of group.querySelectorAll('input')) {
            input.addEventListener(input.type === 'range' ? 'input' : 'change', () => {
                if (input.value !== '' && Number.isFinite(input.valueAsNumber)) this.settings[key].value = input.valueAsNumber;
                this.settingsChanged();
            });
        }
        this.panel?.querySelector(target)?.append(group);
    }
}
