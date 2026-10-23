export type FogMode = 'Game' | 'Custom' | 'Off';
export interface GpuSettings {
    drawDistance: number;
    fogMode: FogMode;
    fogStart: number;
    fogEnd: number;
}
export interface FogRange { start: number; end: number; visibilityEnd: number }
export const DEFAULT_GPU_SETTINGS: GpuSettings = {
    drawDistance: 72, fogMode: 'Custom', fogStart: 65, fogEnd: 100,
};

export function normalizeGpuSettings(settings: GpuSettings): GpuSettings {
    const number = (value: number, min: number, max: number, fallback: number) =>
        Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback;
    const fogEnd = number(settings.fogEnd, 5, 100, 100);
    return {
        drawDistance: number(settings.drawDistance, 24, 128, 72),
        fogMode: ['Game', 'Custom', 'Off'].includes(settings.fogMode) ? settings.fogMode : 'Custom',
        fogStart: Math.min(number(settings.fogStart, 0, 95, 65), fogEnd - 1),
        fogEnd,
    };
}

export interface RenderGame {
    destroyed?: boolean;
    renderDistanceViewDistanceTiles: number;
    performanceRender?: { maxViewDistanceTiles?: number };
    playerX: number;
    playerZ: number;
    entities?: unknown;
    scene: { fogStart: number; fogEnd: number; fogMode: number };
    fogCurrentStart: number;
    fogCurrentEnd: number;
    fogTargetStart: number;
    fogTargetEnd: number;
    fogCurrentVisibilityEndTiles: number;
    fogTargetVisibilityEndTiles: number;
    chunkManager: {
        setRenderDistanceChunkRadius(radius: number): void;
        getRenderDistanceChunkRadius(): number;
        setRenderDistanceTiles(distance: number): void;
        setFogVisibilityDistanceTiles(distance: number): void;
        forceRefreshPlayerPosition(x: number, z: number): unknown;
    };
    applyRenderDistance(value?: unknown): unknown;
    effectiveRenderDistanceViewDistanceTiles(value?: number): number;
    renderDistanceFogRange(start: number, end: number, biome?: boolean): FogRange;
    updateFog(delta: number): void;
    applyFog(): void;
    updateRenderDistanceClipPlane(): void;
    syncNpcVisibleRenderDistance(): unknown;
    updateEntityRenderVisibility(): void;
}

export function isRenderGame(value: unknown): value is RenderGame {
    const game = value as RenderGame | null;
    return !!game?.scene && !game.destroyed && Number.isFinite(game.renderDistanceViewDistanceTiles)
        && ['applyRenderDistance', 'effectiveRenderDistanceViewDistanceTiles', 'renderDistanceFogRange',
            'updateFog', 'applyFog', 'updateRenderDistanceClipPlane', 'syncNpcVisibleRenderDistance',
            'updateEntityRenderVisibility'].every(key => typeof (game as any)[key] === 'function')
        && !!game.chunkManager && ['setRenderDistanceChunkRadius', 'getRenderDistanceChunkRadius',
            'setRenderDistanceTiles', 'setFogVisibilityDistanceTiles', 'forceRefreshPlayerPosition']
            .every(key => typeof (game.chunkManager as any)[key] === 'function');
}

type Method = 'applyRenderDistance' | 'effectiveRenderDistanceViewDistanceTiles'
    | 'renderDistanceFogRange' | 'updateFog' | 'applyFog';

interface FailedChunk { retryAt: number; attempts: number; status?: number }
interface ChunkLoader {
    mapId: string;
    loadMapToken: number;
    loadEditorChunk(x: number, z: number): Promise<void>;
    fetchChunkObjectsUncached(key: string, generation: number): Promise<unknown>;
    failedEditorChunks: Map<string, FailedChunk>;
    failedObjectChunks: Map<string, FailedChunk>;
    nextEditorChunkRetryAt: number;
    nextObjectChunkRetryAt: number;
}

interface FetchHost { fetch: typeof fetch; location: { href: string } }

// The native loader retries every failure, including 404s in immutable map
// generations. Observe responses without changing them or reading credentials.
// Only confirmed, versioned missing files are held; no chunk is marked loaded,
// empty, or collision-ready. The first native error remains visible in the log.
export class ChunkRequestGuard {
    private active = true;
    private positionKey = '';
    private missing = new Set<string>();
    private token: number;
    private held = new Map<FailedChunk, number>();
    private originalFetch: typeof fetch;
    private fetchWrapper: typeof fetch;
    private editorDescriptor: PropertyDescriptor | undefined;
    private objectDescriptor: PropertyDescriptor | undefined;
    private editorWrapper: ChunkLoader['loadEditorChunk'];
    private objectWrapper: ChunkLoader['fetchChunkObjectsUncached'];

    constructor(private loader: ChunkLoader, private host: FetchHost,
        private position?: () => { x: number; z: number }) {
        this.token = loader.loadMapToken;
        this.originalFetch = host.fetch;
        this.editorDescriptor = Object.getOwnPropertyDescriptor(loader, 'loadEditorChunk');
        this.objectDescriptor = Object.getOwnPropertyDescriptor(loader, 'fetchChunkObjectsUncached');
        const editor = loader.loadEditorChunk;
        const objects = loader.fetchChunkObjectsUncached;
        this.fetchWrapper = async (input, init) => {
            const token = loader.loadMapToken;
            const mapId = loader.mapId;
            const response = await this.originalFetch.call(host, input, init);
            if (this.active && response.status === 404 && token === loader.loadMapToken && mapId === loader.mapId) {
                try {
                    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, host.location.href);
                    const match = /^\/maps\/([^/]+)\/(tiles|heights|objects)\/chunk_(-?\d+)_(-?\d+)\.json$/.exec(url.pathname);
                    if (url.origin === new URL(host.location.href).origin && match && decodeURIComponent(match[1]) === mapId
                        && /^[a-f0-9]{64}$/.test(url.searchParams.get('generation') ?? '')) {
                        this.checkMap();
                        this.missing.add(`${match[2] === 'objects' ? 'objects' : 'terrain'}:${match[3]},${match[4]}`);
                    }
                } catch { /* An unrelated or malformed URL must not affect fetching. */ }
            }
            return response;
        };
        this.editorWrapper = async (x, z) => {
            this.checkMap();
            const key = `${x},${z}`;
            if (this.missing.has(`terrain:${key}`) && !this.isNearby(x, z, 64)) return;
            const token = loader.loadMapToken;
            try { await editor.call(loader, x, z); }
            finally {
                if (this.active && token === loader.loadMapToken && this.missing.has(`terrain:${key}`)
                    && !this.isNearby(x, z, 64)) {
                    this.hold(loader.failedEditorChunks.get(key));
                }
            }
        };
        this.objectWrapper = async (key, generation) => {
            this.checkMap();
            const token = loader.loadMapToken;
            try { return await objects.call(loader, key, generation); }
            finally {
                if (this.active && token === loader.loadMapToken && this.missing.has(`objects:${key}`)) {
                    const [x, z] = key.split(',').map(Number);
                    if (!this.isNearby(x, z, 32)) this.hold(loader.failedObjectChunks.get(key));
                }
            }
        };
        try {
            Object.defineProperty(loader, 'loadEditorChunk', { configurable: true, writable: true, value: this.editorWrapper });
            Object.defineProperty(loader, 'fetchChunkObjectsUncached', { configurable: true, writable: true, value: this.objectWrapper });
            host.fetch = this.fetchWrapper;
        } catch (error) {
            this.dispose();
            throw error;
        }
    }

    get count(): number { this.checkMap(); return this.missing.size; }

    retry(): void {
        this.checkMap();
        this.missing.clear();
        for (const entry of this.held.keys()) if (entry.retryAt === Infinity) entry.retryAt = 0;
        this.held.clear();
        this.loader.nextEditorChunkRetryAt = 0;
        this.loader.nextObjectChunkRetryAt = 0;
    }

    dispose(): void {
        this.active = false;
        if (this.host.fetch === this.fetchWrapper) this.host.fetch = this.originalFetch;
        if (this.loader.loadEditorChunk === this.editorWrapper) {
            if (this.editorDescriptor) Object.defineProperty(this.loader, 'loadEditorChunk', this.editorDescriptor);
            else delete (this.loader as Partial<ChunkLoader>).loadEditorChunk;
        }
        if (this.loader.fetchChunkObjectsUncached === this.objectWrapper) {
            if (this.objectDescriptor) Object.defineProperty(this.loader, 'fetchChunkObjectsUncached', this.objectDescriptor);
            else delete (this.loader as Partial<ChunkLoader>).fetchChunkObjectsUncached;
        }
        for (const [entry, retryAt] of this.held) if (entry.retryAt === Infinity) entry.retryAt = retryAt;
        this.missing.clear();
        this.held.clear();
    }

    private checkMap(): void {
        const position = this.position?.();
        const key = position ? `${Math.floor(position.x / 32)},${Math.floor(position.z / 32)}` : '';
        if (this.token === this.loader.loadMapToken && this.positionKey === key) return;
        // Availability can change with movement even within one content version.
        for (const [entry, retryAt] of this.held) if (entry.retryAt === Infinity) entry.retryAt = retryAt;
        this.token = this.loader.loadMapToken;
        this.positionKey = key;
        this.missing.clear();
        this.held.clear();
        this.loader.nextEditorChunkRetryAt = 0;
        this.loader.nextObjectChunkRetryAt = 0;
    }

    private isNearby(x: number, z: number, size: number): boolean {
        const position = this.position?.();
        if (!position) return false;
        return Math.abs(x - Math.floor(position.x / size)) <= 1
            && Math.abs(z - Math.floor(position.z / size)) <= 1;
    }

    private hold(entry: FailedChunk | undefined): void {
        if (!entry || this.held.has(entry)) return;
        this.held.set(entry, entry.retryAt);
        entry.retryAt = Infinity;
    }
}

export class GpuRendering {
    private settings: GpuSettings;
    private restores: Array<() => void> = [];
    private disposed = false;
    private chunkGuard: ChunkRequestGuard | null = null;

    constructor(readonly game: RenderGame, settings: GpuSettings) {
        this.settings = normalizeGpuSettings(settings);
        const applyDistance = game.applyRenderDistance;
        const fogRange = game.renderDistanceFogRange;
        const updateFog = game.updateFog;
        const applyFog = game.applyFog;
        try {
            const loader = game.chunkManager as unknown as ChunkLoader;
            if (typeof window !== 'undefined' && typeof window.fetch === 'function'
                && typeof loader.loadEditorChunk === 'function' && typeof loader.fetchChunkObjectsUncached === 'function'
                && loader.failedEditorChunks instanceof Map && loader.failedObjectChunks instanceof Map) {
                this.chunkGuard = new ChunkRequestGuard(loader, window, () => ({ x: game.playerX, z: game.playerZ }));
            }
            this.override('effectiveRenderDistanceViewDistanceTiles', () => this.distance);
            this.override('applyRenderDistance', (value?: unknown) => {
                const result = applyDistance.call(game, value);
                this.applyDistance();
                return result;
            });
            this.override('renderDistanceFogRange', (start: number, end: number, biome?: boolean) => {
                if (this.settings.fogMode === 'Game') return fogRange.call(game, start, end, biome);
                return {
                    start: this.distance * this.settings.fogStart / 100,
                    end: this.distance * this.settings.fogEnd / 100,
                    // Loading/culling always follows draw distance, not fog start.
                    visibilityEnd: this.distance,
                };
            });
            this.override('updateFog', (delta: number) => {
                updateFog.call(game, delta);
                if (this.settings.fogMode === 'Off') game.scene.fogMode = 0;
            });
            this.override('applyFog', () => {
                applyFog.call(game);
                if (this.settings.fogMode === 'Off') game.scene.fogMode = 0;
            });
            this.refresh();
        } catch (error) {
            this.disposed = true;
            this.chunkGuard?.dispose();
            this.restoreMethods();
            this.restoreNativeView();
            throw error;
        }
    }

    get distance(): number {
        const cap = this.game.performanceRender?.maxViewDistanceTiles;
        return Number.isFinite(cap) && cap! > 0
            ? Math.min(this.settings.drawDistance, cap!) : this.settings.drawDistance;
    }

    get missingChunks(): number { return this.chunkGuard?.count ?? 0; }
    get guardingMissingChunks(): boolean { return this.chunkGuard !== null; }

    retryMissingChunks(): void {
        this.chunkGuard?.retry();
        this.game.chunkManager.forceRefreshPlayerPosition(this.game.playerX, this.game.playerZ);
    }

    setSettings(settings: GpuSettings): void {
        if (this.disposed) return;
        this.settings = normalizeGpuSettings(settings);
        this.refresh();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.chunkGuard?.dispose();
        this.restoreMethods();
        this.restoreNativeView();
    }

    private override(key: Method, replacement: Function): void {
        const descriptor = Object.getOwnPropertyDescriptor(this.game, key);
        this.restores.push(() => {
            if (this.game[key] !== replacement) return;
            if (descriptor) Object.defineProperty(this.game, key, descriptor);
            else delete (this.game as Partial<RenderGame>)[key];
        });
        Object.defineProperty(this.game, key, { configurable: true, writable: true, value: replacement });
    }

    private restoreMethods(): void {
        for (const restore of this.restores.reverse()) restore();
        this.restores = [];
    }

    private applyDistance(): void {
        const game = this.game;
        const distance = this.distance;
        // Verified game chunk size: 32 tiles, terrain culling padding: 8 tiles.
        // The native setter supports up to six chunks in each direction.
        const radius = Math.min(6, Math.ceil((distance + 8) / 32));
        const changed = game.renderDistanceViewDistanceTiles !== distance
            || game.chunkManager.getRenderDistanceChunkRadius() !== radius;
        game.renderDistanceViewDistanceTiles = distance;
        game.fogCurrentVisibilityEndTiles = distance;
        game.fogTargetVisibilityEndTiles = distance;
        game.chunkManager.setRenderDistanceChunkRadius(radius);
        game.chunkManager.setRenderDistanceTiles(distance);
        game.chunkManager.setFogVisibilityDistanceTiles(distance);
        game.updateRenderDistanceClipPlane();
        if (game.entities) {
            game.syncNpcVisibleRenderDistance();
            game.updateEntityRenderVisibility();
        }
        if (changed) game.chunkManager.forceRefreshPlayerPosition(game.playerX, game.playerZ);
    }

    private refresh(): void {
        this.applyDistance();
        // Recompute the current biome's targets without advancing game time.
        this.game.updateFog(0);
        this.snapFogTargets();
    }

    private snapFogTargets(): void {
        const game = this.game;
        if (Number.isFinite(game.fogTargetStart) && Number.isFinite(game.fogTargetEnd)) {
            game.scene.fogStart = game.fogCurrentStart = game.fogTargetStart;
            game.scene.fogEnd = game.fogCurrentEnd = game.fogTargetEnd;
        }
        if (!this.disposed && this.settings.fogMode === 'Off') game.scene.fogMode = 0;
    }

    private restoreNativeView(): void {
        if (this.game.destroyed) return;
        try {
            // Reads the current native settings, including any changes made while
            // the plugin was running, rather than restoring an old snapshot.
            this.game.applyRenderDistance();
            this.game.applyFog();
            this.game.updateFog(0);
            this.snapFogTargets();
        } catch {
            // Logout can dispose the previous scene before plugins are stopped.
        }
    }
}
