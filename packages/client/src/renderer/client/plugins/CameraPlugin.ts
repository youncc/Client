import { Plugin, SettingsTypes, PanelManager } from '@camelkit/core';
import { CameraZoom, DEFAULT_ZOOM_LIMITS, isGameCamera, normalizeZoomLimits } from '../helpers/cameraZoom';
import type { ZoomLimits } from '../helpers/cameraZoom';

export default class CameraPlugin extends Plugin {
    pluginName = 'Camera';
    author = 'CamelKit';
    version = '0.1.0';

    private panelManager = new PanelManager();
    private panel: HTMLElement | null = null;
    private status: HTMLElement | null = null;
    private controls = new Map<keyof ZoomLimits, { range: HTMLInputElement; number: HTMLInputElement }>();
    private cameraZoom: CameraZoom | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private running = false;
    private failedCamera: unknown = null;

    constructor() {
        super();
        this.settings.zoomIn = {
            text: 'Zoom-in limit (%)',
            description: '100% is the normal closest distance. Lower values let you zoom closer.',
            type: SettingsTypes.range, value: 100, min: 25, max: 100,
            callback: () => this.settingsChanged(),
        };
        this.settings.zoomOut = {
            text: 'Zoom-out limit (%)',
            description: '100% is the normal farthest distance. Higher values let you zoom farther out.',
            type: SettingsTypes.range, value: 100, min: 100, max: 300,
            callback: () => this.settingsChanged(),
        };
    }

    init(): void {
        this.normalizeSettings();
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        const [icon, panel] = this.panelManager.requestMenuItem('📷', 'Camera');
        icon.title = 'Camera';
        icon.setAttribute('role', 'button');
        icon.setAttribute('aria-label', 'Camera');
        icon.tabIndex = 0;
        icon.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                icon.click();
            }
        });
        this.panel = panel;
        this.renderPanel();
        this.attachCamera();
        // Cameras are recreated on login/world changes. No per-frame overrides.
        this.timer = setInterval(() => this.attachCamera(), 500);
    }

    stop(): void {
        this.running = false;
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        this.releaseCamera();
        this.failedCamera = null;
        this.panelManager.removeMenuItem('📷');
        this.panel = null;
        this.status = null;
        this.controls.clear();
    }

    private normalizeSettings(): ZoomLimits {
        const limits = normalizeZoomLimits({
            zoomIn: Number(this.settings.zoomIn.value),
            zoomOut: Number(this.settings.zoomOut.value),
        });
        this.settings.zoomIn.value = limits.zoomIn;
        this.settings.zoomOut.value = limits.zoomOut;
        return limits;
    }

    private settingsChanged(): void {
        const limits = this.normalizeSettings();
        try {
            this.cameraZoom?.setLimits(limits);
        } catch (error) {
            this.warn('Could not update camera zoom limits:', error);
            this.releaseCamera();
            this.setStatus('Camera unavailable. Waiting to reconnect.');
        }
        for (const [key, control] of this.controls) {
            control.range.value = String(limits[key]);
            control.number.value = String(limits[key]);
        }
    }

    private attachCamera(): void {
        if (!this.running) return;
        const hooks = this.gameHooks as any;
        const gm = hooks?.GameManager?.Instance ?? (window as any).gm;
        const manager = gm?.camera ?? hooks?.GameCameraManager?.Instance;
        if (this.cameraZoom && this.cameraZoom.manager === manager) return;
        this.releaseCamera();
        if (!isGameCamera(manager)) {
            this.setStatus('Waiting for the game camera…');
            return;
        }
        if (this.failedCamera === manager) return;
        try {
            this.cameraZoom = new CameraZoom(manager, this.normalizeSettings());
            this.failedCamera = null;
            this.setStatus('Ready. Scroll over the game to zoom.');
        } catch (error) {
            this.failedCamera = manager;
            this.warn('Could not attach camera zoom controls:', error);
            this.setStatus('This game camera is not supported. Normal zoom is unchanged.');
        }
    }

    private releaseCamera(): void {
        try {
            this.cameraZoom?.dispose();
        } catch (error) {
            // A previous world's camera may already have been disposed.
            this.warn('Could not refresh the previous camera:', error);
        }
        this.cameraZoom = null;
    }

    private setStatus(message: string): void {
        if (this.status && this.status.textContent !== message) this.status.textContent = message;
    }

    private renderPanel(): void {
        if (!this.panel) return;
        this.controls.clear();
        Object.assign(this.panel.style, {
            width: '100%', padding: '14px', boxSizing: 'border-box',
            color: 'var(--theme-text-primary)', background: 'var(--theme-background)',
            font: '13px/1.5 Inter, system-ui, sans-serif',
        });
        this.panel.replaceChildren();
        const heading = document.createElement('h3');
        heading.textContent = 'Zoom limits';
        heading.style.margin = '0 0 8px';
        const description = document.createElement('p');
        description.textContent = 'Get closer or pull farther back. 100% uses the game’s normal zoom limit.';
        description.style.color = 'var(--theme-text-muted)';
        this.panel.append(heading, description);
        this.addControl('zoomIn', 'Zoom-in limit', 25, 100, 'Lower values let you zoom closer.');
        this.addControl('zoomOut', 'Zoom-out limit', 100, 300, 'Higher values let you zoom farther out.');

        const reset = document.createElement('button');
        reset.type = 'button';
        reset.textContent = 'Reset zoom limits';
        Object.assign(reset.style, {
            width: '100%', padding: '8px', marginTop: '8px', cursor: 'pointer',
            color: 'var(--theme-text-primary)', background: 'var(--theme-background-mute)',
            border: '1px solid var(--theme-border)', borderRadius: '4px',
        });
        reset.addEventListener('click', () => {
            this.settings.zoomIn.value = DEFAULT_ZOOM_LIMITS.zoomIn;
            this.settings.zoomOut.value = DEFAULT_ZOOM_LIMITS.zoomOut;
            this.settingsChanged();
        });
        this.status = document.createElement('p');
        this.status.setAttribute('role', 'status');
        this.status.style.color = 'var(--theme-text-muted)';
        this.panel.append(reset, this.status);
        this.settingsChanged();
    }

    private addControl(key: keyof ZoomLimits, title: string, min: number, max: number, hint: string): void {
        const group = document.createElement('div');
        group.style.margin = '18px 0';
        const label = document.createElement('label');
        label.htmlFor = `camelkit-camera-${key}`;
        label.textContent = title;
        label.style.fontWeight = '600';
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' });
        const range = document.createElement('input');
        range.type = 'range';
        range.id = label.htmlFor;
        Object.assign(range.style, { flex: '1', minWidth: '0', accentColor: 'var(--theme-accent, #b99d65)' });
        const number = document.createElement('input');
        number.type = 'number';
        number.setAttribute('aria-label', `${title} percentage`);
        Object.assign(number.style, {
            width: '52px', padding: '5px', border: '1px solid var(--theme-border)',
            borderRadius: '4px', color: 'var(--theme-text-primary)', background: 'var(--theme-background-mute)',
        });
        for (const input of [range, number]) {
            input.min = String(min);
            input.max = String(max);
            input.step = '1';
            input.value = String(this.settings[key].value);
        }
        const change = (input: HTMLInputElement) => {
            if (input.value === '' || !Number.isFinite(input.valueAsNumber)) {
                input.value = String(this.settings[key].value);
                return;
            }
            this.settings[key].value = input.valueAsNumber;
            this.settingsChanged();
        };
        range.addEventListener('input', () => change(range));
        number.addEventListener('change', () => change(number));
        const percent = document.createElement('span');
        percent.textContent = '%';
        const note = document.createElement('small');
        note.textContent = hint;
        note.style.color = 'var(--theme-text-muted)';
        row.append(range, number, percent);
        group.append(label, row, note);
        this.panel?.append(group);
        this.controls.set(key, { range, number });
    }
}
