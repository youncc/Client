export interface ZoomLimits {
    zoomIn: number;
    zoomOut: number;
}

export interface GameCamera {
    camera: { radius: number; lowerRadiusLimit: number | null; upperRadiusLimit: number | null };
    lockedMinRadius(): number;
    lockedMaxRadius(): number;
    applyGameplayView(): void;
}

export const DEFAULT_ZOOM_LIMITS: ZoomLimits = { zoomIn: 100, zoomOut: 100 };

export function normalizeZoomLimits(limits: ZoomLimits): ZoomLimits {
    const bounded = (value: number, min: number, max: number) =>
        Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : 100;
    return {
        zoomIn: bounded(limits.zoomIn, 25, 100),
        zoomOut: bounded(limits.zoomOut, 100, 300),
    };
}

export function isGameCamera(value: unknown): value is GameCamera {
    const manager = value as GameCamera | null;
    return !!manager?.camera && Number.isFinite(manager.camera.radius)
        && typeof manager.lockedMinRadius === 'function'
        && typeof manager.lockedMaxRadius === 'function'
        && typeof manager.applyGameplayView === 'function';
}

// The game reapplies its limits during pitch, obstruction, and viewport updates.
// Wrap the instance's limit getters so all those paths use the same settings.
export class CameraZoom {
    private limits: ZoomLimits;
    private originalMin: GameCamera['lockedMinRadius'];
    private originalMax: GameCamera['lockedMaxRadius'];
    private minDescriptor: PropertyDescriptor | undefined;
    private maxDescriptor: PropertyDescriptor | undefined;
    private minWrapper: GameCamera['lockedMinRadius'];
    private maxWrapper: GameCamera['lockedMaxRadius'];
    private disposed = false;

    constructor(readonly manager: GameCamera, limits: ZoomLimits) {
        this.limits = normalizeZoomLimits(limits);
        this.originalMin = manager.lockedMinRadius;
        this.originalMax = manager.lockedMaxRadius;
        const min = this.originalMin.call(manager);
        const max = this.originalMax.call(manager);
        if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= min) {
            throw new Error('Unsupported camera zoom limits');
        }
        this.minDescriptor = Object.getOwnPropertyDescriptor(manager, 'lockedMinRadius');
        this.maxDescriptor = Object.getOwnPropertyDescriptor(manager, 'lockedMaxRadius');
        this.minWrapper = () => this.originalMin.call(manager) * this.limits.zoomIn / 100;
        this.maxWrapper = () => this.originalMax.call(manager) * this.limits.zoomOut / 100;
        try {
            Object.defineProperty(manager, 'lockedMinRadius', {
                configurable: true, writable: true, value: this.minWrapper,
            });
            Object.defineProperty(manager, 'lockedMaxRadius', {
                configurable: true, writable: true, value: this.maxWrapper,
            });
            manager.applyGameplayView();
        } catch (error) {
            this.restoreGetters();
            throw error;
        }
    }

    setLimits(limits: ZoomLimits): void {
        if (this.disposed) return;
        this.limits = normalizeZoomLimits(limits);
        // Rebase the native zoom offset and clear stale obstruction state.
        this.manager.applyGameplayView();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.restoreGetters();
        this.manager.applyGameplayView();
    }

    private restoreGetters(): void {
        if (this.manager.lockedMinRadius === this.minWrapper) {
            if (this.minDescriptor) Object.defineProperty(this.manager, 'lockedMinRadius', this.minDescriptor);
            else delete (this.manager as Partial<GameCamera>).lockedMinRadius;
        }
        if (this.manager.lockedMaxRadius === this.maxWrapper) {
            if (this.maxDescriptor) Object.defineProperty(this.manager, 'lockedMaxRadius', this.maxDescriptor);
            else delete (this.manager as Partial<GameCamera>).lockedMaxRadius;
        }
    }
}
