import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/renderer/client/helpers/gpuRendering.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { GpuRendering, ChunkRequestGuard, DEFAULT_GPU_SETTINGS, normalizeGpuSettings } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

function missingChunkFixture(status = 404, versioned = true) {
    let requests = 0;
    const host = {
        location: { href: 'https://world2.memoriesofmagic.com/play' },
        async fetch() { requests++; return new Response('{}', { status }); },
    };
    const loader = {
        mapId: 'kcmap', loadMapToken: 1,
        failedEditorChunks: new Map(), failedObjectChunks: new Map(),
        nextEditorChunkRetryAt: 0, nextObjectChunkRetryAt: 0,
        loadedEditorChunks: new Set(), chunksKnownEmpty: new Set(),
        url(kind, key) {
            return `/maps/${this.mapId}/${kind}/chunk_${key.replace(',', '_')}.json${versioned ? `?generation=${'a'.repeat(64)}` : ''}`;
        },
        async loadEditorChunk(x, z) {
            const key = `${x},${z}`;
            const result = await host.fetch(this.url('tiles', key));
            if (!result.ok) this.failedEditorChunks.set(key, { retryAt: 100, attempts: 1 });
        },
        async fetchChunkObjectsUncached(key) {
            const result = await host.fetch(this.url('objects', key));
            if (!result.ok) {
                this.failedObjectChunks.set(key, { retryAt: 100, attempts: 1, status: result.status });
                throw new Error(`HTTP ${result.status}`);
            }
            return [];
        },
    };
    return { host, loader, requests: () => requests };
}

test('confirmed immutable 404s stop terrain retries without inventing loaded or empty chunks', async () => {
    const { host, loader, requests } = missingChunkFixture();
    const guard = new ChunkRequestGuard(loader, host);
    await loader.loadEditorChunk(4, 5);
    assert.equal(loader.failedEditorChunks.get('4,5').retryAt, Infinity);
    await loader.loadEditorChunk(4, 5);
    assert.equal(requests(), 1);
    assert.equal(guard.count, 1);
    assert.equal(loader.loadedEditorChunks.size, 0);
    assert.equal(loader.chunksKnownEmpty.size, 0);
    await assert.rejects(loader.fetchChunkObjectsUncached('12,9', 0), /404/);
    assert.equal(loader.failedObjectChunks.get('12,9').retryAt, Infinity);
    guard.retry();
    assert.equal(guard.count, 0);
    assert.equal(loader.failedEditorChunks.get('4,5').retryAt, 0);
    await loader.loadEditorChunk(4, 5);
    assert.equal(requests(), 3, 'Manual retry makes a new request');
    guard.dispose();
    assert.equal(loader.failedEditorChunks.get('4,5').retryAt, 100);
});

test('temporary failures and unversioned 404s retain normal retry behavior', async () => {
    for (const [status, versioned] of [[503, true], [429, true], [404, false]]) {
        const { host, loader, requests } = missingChunkFixture(status, versioned);
        const guard = new ChunkRequestGuard(loader, host);
        await loader.loadEditorChunk(4, 5);
        await loader.loadEditorChunk(4, 5);
        assert.equal(requests(), 2);
        assert.equal(guard.count, 0);
        assert.equal(loader.failedEditorChunks.get('4,5').retryAt, 100);
        guard.dispose();
    }
});

test('new map loads forget unavailable chunks and ignore responses from the previous map', async () => {
    const { host, loader, requests } = missingChunkFixture();
    const guard = new ChunkRequestGuard(loader, host);
    await loader.loadEditorChunk(4, 5);
    loader.loadMapToken++;
    loader.failedEditorChunks.clear();
    assert.equal(guard.count, 0);
    await loader.loadEditorChunk(4, 5);
    assert.equal(requests(), 2);
    guard.dispose();
});

test('disposing the guard restores fetch and prevents late responses from pausing retries', async () => {
    const { host, loader } = missingChunkFixture();
    let resolve;
    const originalFetch = host.fetch = () => new Promise(done => { resolve = done; });
    const editorDescriptor = Object.getOwnPropertyDescriptor(loader, 'loadEditorChunk');
    const guard = new ChunkRequestGuard(loader, host);
    const pending = loader.loadEditorChunk(4, 5);
    guard.dispose();
    resolve(new Response('{}', { status: 404 }));
    await pending;
    assert.equal(loader.failedEditorChunks.get('4,5').retryAt, 100);
    assert.equal(host.fetch, originalFetch);
    assert.deepEqual(Object.getOwnPropertyDescriptor(loader, 'loadEditorChunk'), editorDescriptor);
});

test('nearby chunks keep retrying and moving clears held distant requests', async () => {
    const { host, loader, requests } = missingChunkFixture();
    const position = { x: 256, z: 320 };
    const guard = new ChunkRequestGuard(loader, host, () => position);
    await loader.loadEditorChunk(4, 5);
    await loader.loadEditorChunk(4, 5);
    assert.equal(requests(), 2, 'A chunk near the character is never blocked');
    assert.equal(loader.failedEditorChunks.get('4,5').retryAt, 100);
    await loader.loadEditorChunk(10, 10);
    assert.equal(loader.failedEditorChunks.get('10,10').retryAt, Infinity);
    position.x = 640;
    position.z = 640;
    assert.equal(guard.count, 0);
    assert.equal(loader.failedEditorChunks.get('10,10').retryAt, 100);
    await loader.loadEditorChunk(10, 10);
    assert.equal(loader.failedEditorChunks.get('10,10').retryAt, 100);
    guard.dispose();
});

export class Color {
    constructor(r = 0, g = 0, b = 0) { this.set(r, g, b); }
    set(r, g, b) { Object.assign(this, { r, g, b }); }
    clone() { return new Color(this.r, this.g, this.b); }
}

export function fixture() {
    const chunks = {
        radius: 2, renderDistanceTiles: 36, fogVisibilityDistanceTiles: 36, refreshes: 0,
        meta: { fogStart: 8, fogEnd: 36, fogColor: [0.3, 0.4, 0.5] },
        getMeta() { return this.meta; },
        getRenderDistanceChunkRadius() { return this.radius; },
        setRenderDistanceChunkRadius(radius) { this.radius = radius; },
        setRenderDistanceTiles(distance) { this.renderDistanceTiles = distance; },
        setFogVisibilityDistanceTiles(distance) { this.fogVisibilityDistanceTiles = distance; },
        forceRefreshPlayerPosition() { this.refreshes++; },
    };
    const game = {
        scene: { fogStart: 8, fogEnd: 36, fogMode: 3, fogColor: new Color(), clearColor: new Color() },
        performanceRender: { maxViewDistanceTiles: Infinity },
        renderDistanceViewDistanceTiles: 36, fogCurrentVisibilityEndTiles: 36,
        fogCurrentStart: 8, fogCurrentEnd: 36, fogTargetStart: 8, fogTargetEnd: 36,
        fogTargetColor: new Color(), fogCurrentColor: new Color(),
        biomesFile: null, underTerrainVoidActive: false,
        chunkManager: chunks, playerX: 10, playerZ: 10, entities: {},
        camera: {
            value: { radius: 12, beta: 1.18, maxZ: 60 },
            getCamera() { return this.value; },
            clipDistanceForTargetPlaneDistance(distance) { return distance + this.value.radius; },
        },
        skybox: { setConfig() {} }, skyboxConfigFor() { return {}; },
        applySceneFogColor() {}, syncNpcVisibleRenderDistance() {}, updateEntityRenderVisibility() {},
        effectiveRenderDistanceViewDistanceTiles(value = this.renderDistanceViewDistanceTiles) { return value; },
        applyRenderDistance() {
            this.renderDistanceViewDistanceTiles = Math.min(36, this.performanceRender.maxViewDistanceTiles);
            chunks.setRenderDistanceChunkRadius(2);
            chunks.setRenderDistanceTiles(this.effectiveRenderDistanceViewDistanceTiles());
            this.updateRenderDistanceClipPlane();
        },
        updateRenderDistanceClipPlane() {
            this.camera.value.maxZ = this.camera.clipDistanceForTargetPlaneDistance(this.effectiveRenderDistanceViewDistanceTiles());
        },
        renderDistanceFogRange(start, end) {
            return { start, end: Math.min(end, this.renderDistanceViewDistanceTiles), visibilityEnd: this.renderDistanceViewDistanceTiles };
        },
        updateFog() {
            const range = this.renderDistanceFogRange(chunks.meta.fogStart, chunks.meta.fogEnd);
            this.fogTargetStart = this.fogCurrentStart = this.scene.fogStart = range.start;
            this.fogTargetEnd = this.fogCurrentEnd = this.scene.fogEnd = range.end;
            this.fogCurrentVisibilityEndTiles = range.visibilityEnd;
            this.scene.fogMode = 3;
            chunks.setFogVisibilityDistanceTiles(range.visibilityEnd);
            this.updateRenderDistanceClipPlane();
        },
        applyFog() { this.updateFog(0); },
    };
    return game;
}

test('GPU startup leaves native loading untouched until login and map bootstrap finish', async () => {
    const helperUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
    const core = `export class Plugin { settings={enable:{value:true}}; info(){}; warn(){} }
        export const SettingsTypes={range:1,combobox:5};
        export class PanelManager {requestMenuItem(){return [{setAttribute(){},addEventListener(){}},{querySelector(){return null}}]};removeMenuItem(){}}`;
    const coreUrl = `data:text/javascript;base64,${Buffer.from(core).toString('base64')}`;
    const pluginSource = readFileSync(new URL('../src/renderer/client/plugins/GpuPlugin.ts', import.meta.url), 'utf8');
    let pluginJs = ts.transpileModule(pluginSource, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText;
    pluginJs = pluginJs.replace(/(['"])@camelkit\/core\1/, JSON.stringify(coreUrl))
        .replace(/(['"])\.\.\/helpers\/gpuRendering\1/, JSON.stringify(helperUrl));
    const { default: GpuPlugin } = await import(`data:text/javascript;base64,${Buffer.from(pluginJs).toString('base64')}`);
    const game = fixture();
    game.localPlayer = {};
    game.loginBootstrap = { settled: false };
    const plugin = new GpuPlugin();
    Object.defineProperty(plugin, 'gameHooks', { get: () => ({ GameManager: { Instance: game } }) });
    plugin.renderPanel = () => {};
    try {
        plugin.start();
        assert.equal(game.renderDistanceViewDistanceTiles, 36);
        assert.equal(game.chunkManager.refreshes, 0);
        game.loginBootstrap.settled = true;
        plugin.attachGame();
        assert.equal(game.renderDistanceViewDistanceTiles, 72);
        game.activeMapChangeSeq = 1;
        plugin.attachGame();
        assert.equal(game.renderDistanceViewDistanceTiles, 36, 'Map changes restore native loading');
    } finally { plugin.stop(); }
});

test('draw distance updates loading, culling, fog visibility and camera clipping together', () => {
    const game = fixture();
    const gpu = new GpuRendering(game, DEFAULT_GPU_SETTINGS);
    assert.equal(game.renderDistanceViewDistanceTiles, 72);
    assert.equal(game.chunkManager.radius, 3);
    assert.equal(game.chunkManager.renderDistanceTiles, 72);
    assert.equal(game.chunkManager.fogVisibilityDistanceTiles, 72);
    assert.equal(game.scene.fogStart, 46.8);
    assert.equal(game.scene.fogEnd, 72);
    assert.equal(game.chunkManager.refreshes, 1);
    game.camera.value.radius = 40;
    game.updateFog(1 / 60);
    assert.ok(game.camera.value.maxZ > 100);
    gpu.setSettings({ ...DEFAULT_GPU_SETTINGS, fogStart: 50 });
    assert.equal(game.chunkManager.refreshes, 1, 'Fog-only edits do not restart streaming');
    game.applyRenderDistance();
    assert.equal(game.renderDistanceViewDistanceTiles, 72, 'Native settings updates retain the override');
    gpu.dispose();
});

test('fog off survives frame updates and can be switched back to authored game fog', () => {
    const game = fixture();
    const gpu = new GpuRendering(game, { ...DEFAULT_GPU_SETTINGS, fogMode: 'Off' });
    for (let frame = 0; frame < 30; frame++) game.updateFog(1 / 60);
    assert.equal(game.scene.fogMode, 0);
    game.applyFog();
    assert.equal(game.scene.fogMode, 0);
    gpu.setSettings({ ...DEFAULT_GPU_SETTINGS, fogMode: 'Game' });
    assert.equal(game.scene.fogMode, 3);
    assert.equal(game.scene.fogStart, 8);
    assert.equal(game.scene.fogEnd, 36);
    gpu.dispose();
});

test('Low GPU mode retains its native cap across performance changes', () => {
    const game = fixture();
    const gpu = new GpuRendering(game, { ...DEFAULT_GPU_SETTINGS, drawDistance: 128 });
    assert.equal(game.chunkManager.radius, 5);
    game.performanceRender.maxViewDistanceTiles = 30;
    game.applyRenderDistance();
    assert.equal(gpu.distance, 30);
    assert.equal(game.renderDistanceViewDistanceTiles, 30);
    assert.equal(game.chunkManager.renderDistanceTiles, 30);
    game.performanceRender.maxViewDistanceTiles = Infinity;
    game.applyRenderDistance();
    assert.equal(gpu.distance, 128);
    gpu.dispose();
});

test('disable restores native distance, fog and instance method descriptors', () => {
    const game = fixture();
    const original = Object.getOwnPropertyDescriptor(game, 'updateFog');
    const gpu = new GpuRendering(game, { ...DEFAULT_GPU_SETTINGS, fogMode: 'Off' });
    gpu.dispose();
    assert.equal(game.renderDistanceViewDistanceTiles, 36);
    assert.equal(game.chunkManager.radius, 2);
    assert.equal(game.scene.fogMode, 3);
    assert.equal(game.scene.fogEnd, 36);
    assert.deepEqual(Object.getOwnPropertyDescriptor(game, 'updateFog'), original);
    gpu.dispose();
});

test('invalid stored settings stay finite, bounded and have ordered fog endpoints', () => {
    assert.deepEqual(normalizeGpuSettings({ drawDistance: NaN, fogMode: 'invalid', fogStart: Infinity, fogEnd: NaN }), DEFAULT_GPU_SETTINGS);
    const settings = normalizeGpuSettings({ drawDistance: 900, fogMode: 'Custom', fogStart: 95, fogEnd: 5 });
    assert.equal(settings.drawDistance, 128);
    assert.ok(settings.fogStart < settings.fogEnd);
});

test('failed attachment removes overrides and restores normal fog', () => {
    const game = fixture();
    const original = Object.getOwnPropertyDescriptor(game, 'updateFog');
    game.updateRenderDistanceClipPlane = () => { throw new Error('Scene disposed'); };
    assert.throws(() => new GpuRendering(game, { ...DEFAULT_GPU_SETTINGS, fogMode: 'Off' }), /Scene disposed/);
    assert.deepEqual(Object.getOwnPropertyDescriptor(game, 'updateFog'), original);
    assert.equal(game.effectiveRenderDistanceViewDistanceTiles(36), 36);
});

test('current native game methods retain extended fog and clip distance through frames', {
    skip: !process.env.CAMELKIT_GPU_GAME_BUNDLE,
}, () => {
    const game = fixture();
    const text = readFileSync(process.env.CAMELKIT_GPU_GAME_BUNDLE, 'utf8');
    const ast = ts.createSourceFile('game.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declaration = ast.statements.find(statement => ts.isClassDeclaration(statement)
        && statement.members.some(member => member.name?.getText(ast) === 'renderDistanceFogRange'));
    const names = ['applyRenderDistance', 'effectiveRenderDistanceViewDistanceTiles', 'renderDistanceFogRange',
        'updateRenderDistanceClipPlane', 'updateFog', 'applyFog'];
    const methods = declaration.members.filter(member => names.includes(member.name?.getText(ast))).map(member => member.getText(ast));
    assert.equal(methods.length, names.length);
    const fogFunction = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === '_E');
    const native = new Function('F', '$', `const IE=.5, Bf=26, mh=32, Jo={}, Ir=()=>1, zi={FOGMODE_LINEAR:3,FOGMODE_NONE:0}, Lh=()=>({viewDistanceTiles:36,chunkRadius:2});
        ${fogFunction.getText(ast)}; return {${methods.join(',')}};`)(Color, Color);
    Object.assign(game, native);
    const cameraClass = ast.statements.find(statement => ts.isClassDeclaration(statement)
        && statement.members.some(member => member.name?.getText(ast) === 'clipDistanceForTargetPlaneDistance'));
    const clip = cameraClass.members.find(member => member.name?.getText(ast) === 'clipDistanceForTargetPlaneDistance');
    game.camera.clipDistanceForTargetPlaneDistance = new Function(`return {${clip.getText(ast)}}`)().clipDistanceForTargetPlaneDistance;
    game.camera.camera = game.camera.value;
    const gpu = new GpuRendering(game, DEFAULT_GPU_SETTINGS);
    for (let frame = 0; frame < 60; frame++) game.updateFog(1 / 60);
    assert.equal(game.renderDistanceViewDistanceTiles, 72);
    assert.equal(game.scene.fogEnd, 72);
    game.camera.value.radius = 40;
    game.updateFog(1 / 60);
    assert.ok(game.camera.value.maxZ > 100);
    gpu.setSettings({ ...DEFAULT_GPU_SETTINGS, fogMode: 'Off' });
    game.updateFog(1 / 60);
    assert.equal(game.scene.fogMode, 0);
    gpu.dispose();
    assert.equal(game.renderDistanceViewDistanceTiles, 36);
    assert.equal(game.scene.fogMode, 3);
    assert.equal(game.scene.fogEnd, 36);
});

test('native chunk setters retain enough terrain and scenery for the selected distance', {
    skip: !process.env.CAMELKIT_GPU_CHUNK_BUNDLE,
}, () => {
    const text = readFileSync(process.env.CAMELKIT_GPU_CHUNK_BUNDLE, 'utf8');
    const ast = ts.createSourceFile('chunks.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declaration = ast.statements.find(statement => ts.isClassDeclaration(statement)
        && statement.members.some(member => member.name?.getText(ast) === 'setRenderDistanceChunkRadius'));
    const names = ['setRenderDistanceChunkRadius', 'getRenderDistanceChunkRadius', 'setRenderDistanceTiles',
        'setFogVisibilityDistanceTiles', 'getVisibilityDistanceTiles', 'getRenderDistanceTiles',
        'getObjectRenderDistanceTiles', 'getRenderDistanceBucket', 'getObjectVisibilityDistanceBucket'];
    const methods = declaration.members.filter(member => names.includes(member.name?.getText(ast))).map(member => member.getText(ast));
    assert.equal(methods.length, names.length);
    const native = new Function(`const vi=2,Zc=2,j=32,Uo=16,Sc=8,Rc=0,Xc=8,qs=4;return {${methods.join(',')}};`)();
    const game = fixture();
    Object.assign(game.chunkManager, native, { renderDistanceChunkRadius: 2 });
    const gpu = new GpuRendering(game, { ...DEFAULT_GPU_SETTINGS, drawDistance: 128 });
    assert.equal(game.chunkManager.getRenderDistanceChunkRadius(), 5);
    assert.equal(game.chunkManager.getRenderDistanceTiles(), 136);
    assert.equal(game.chunkManager.getObjectRenderDistanceTiles(), 128);
    assert.ok(game.chunkManager.getRenderDistanceChunkRadius() * 32 >= game.chunkManager.getRenderDistanceTiles());
    gpu.dispose();
    assert.equal(game.chunkManager.getRenderDistanceChunkRadius(), 2);
    assert.equal(game.chunkManager.getObjectRenderDistanceTiles(), 36);
});

test('the native terrain loader reports a missing chunk once and does not retry it endlessly', {
    skip: !process.env.CAMELKIT_GPU_CHUNK_BUNDLE,
}, async () => {
    const text = readFileSync(process.env.CAMELKIT_GPU_CHUNK_BUNDLE, 'utf8');
    const ast = ts.createSourceFile('chunks.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declaration = ast.statements.find(statement => ts.isClassDeclaration(statement)
        && statement.members.some(member => member.name?.getText(ast) === 'setRenderDistanceChunkRadius'));
    const method = declaration.members.find(member => member.name?.getText(ast) === 'loadEditorChunk');
    const { host, loader, requests } = missingChunkFixture();
    const warnings = [];
    const load = new Function('sa', 'console', `const Y=64,Bc=1000,Dc=10000,jo=750;return {${method.getText(ast)}};`)(
        async (url) => {
            const response = await host.fetch(url);
            if (!response.ok) throw Object.assign(new Error('Missing chunk'), { mapResourceStatus: response.status });
            return response;
        }, { warn: (...args) => warnings.push(args) },
    ).loadEditorChunk;
    Object.assign(loader, {
        loadEditorChunk: load, loadingEditorChunks: new Set(), editorChunkRequests: new Map(),
        mapOriginX: 0, mapOriginZ: 0, mapWidth: 1024, mapHeight: 1024,
        activeChunks: null, scene: { isDisposed: false },
        mapResourceUrl: path => `${path}?generation=${'a'.repeat(64)}`,
    });
    const guard = new ChunkRequestGuard(loader, host);
    await loader.loadEditorChunk(4, 5);
    assert.equal(loader.failedEditorChunks.get('4,5').retryAt, Infinity);
    await loader.loadEditorChunk(4, 5);
    assert.equal(requests(), 2, 'Only the initial tiles and heights requests are made');
    assert.equal(warnings.length, 1, 'The first native error is preserved');
    assert.equal(loader.loadedEditorChunks.size, 0);
    guard.dispose();
});
