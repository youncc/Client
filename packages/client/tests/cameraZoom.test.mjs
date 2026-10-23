import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/renderer/client/helpers/cameraZoom.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { CameraZoom, normalizeZoomLimits } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

class CameraFixture {
    scale = 1;
    camera = { radius: 12, lowerRadiusLimit: 8, upperRadiusLimit: 14 };
    lockedMinRadius() { return 8 * this.scale; }
    lockedMaxRadius() { return 14 * this.scale; }
    applyGameplayView() {
        this.camera.lowerRadiusLimit = this.lockedMinRadius();
        this.camera.upperRadiusLimit = this.lockedMaxRadius();
        this.camera.radius = Math.min(this.camera.upperRadiusLimit, Math.max(this.camera.lowerRadiusLimit, this.camera.radius));
    }
}

test('extended limits survive native reapplication and changing viewport scale', () => {
    const manager = new CameraFixture();
    const zoom = new CameraZoom(manager, { zoomIn: 25, zoomOut: 300 });
    assert.equal(manager.camera.lowerRadiusLimit, 2);
    assert.equal(manager.camera.upperRadiusLimit, 42);
    manager.scale = 1.5;
    manager.camera.radius = 100;
    manager.applyGameplayView();
    assert.equal(manager.camera.lowerRadiusLimit, 3);
    assert.equal(manager.camera.upperRadiusLimit, 63);
    assert.equal(manager.camera.radius, 63);
    zoom.dispose();
    assert.equal(manager.camera.lowerRadiusLimit, 12);
    assert.equal(manager.camera.upperRadiusLimit, 21);
    assert.equal(manager.camera.radius, 21);
    assert.equal(Object.hasOwn(manager, 'lockedMinRadius'), false);
    assert.equal(Object.hasOwn(manager, 'lockedMaxRadius'), false);
    zoom.dispose();
});

test('reset clamps an extended camera back into the normal range', () => {
    const manager = new CameraFixture();
    const zoom = new CameraZoom(manager, { zoomIn: 25, zoomOut: 300 });
    manager.camera.radius = 40;
    zoom.setLimits({ zoomIn: 100, zoomOut: 100 });
    assert.equal(manager.camera.radius, 14);
    assert.equal(manager.camera.lowerRadiusLimit, 8);
    assert.equal(manager.camera.upperRadiusLimit, 14);
    zoom.dispose();
});

test('invalid or stale stored preferences cannot produce invalid limits', () => {
    assert.deepEqual(normalizeZoomLimits({ zoomIn: NaN, zoomOut: Infinity }), { zoomIn: 100, zoomOut: 100 });
    assert.deepEqual(normalizeZoomLimits({ zoomIn: -1, zoomOut: 9999 }), { zoomIn: 25, zoomOut: 300 });
    assert.deepEqual(normalizeZoomLimits({ zoomIn: 50.4, zoomOut: 149.8 }), { zoomIn: 50, zoomOut: 150 });
});

test('failed attachment restores the original own-property descriptors', () => {
    const manager = new CameraFixture();
    Object.defineProperty(manager, 'lockedMinRadius', { configurable: true, value: () => 8 });
    const original = Object.getOwnPropertyDescriptor(manager, 'lockedMinRadius');
    manager.applyGameplayView = () => { throw new Error('Disposed camera'); };
    assert.throws(() => new CameraZoom(manager, { zoomIn: 25, zoomOut: 300 }), /Disposed camera/);
    assert.deepEqual(Object.getOwnPropertyDescriptor(manager, 'lockedMinRadius'), original);
    assert.equal(Object.hasOwn(manager, 'lockedMaxRadius'), false);
});

test('the current game pitch/scroll algorithms retain extended limits and restore defaults', {
    skip: !process.env.CAMELKIT_CAMERA_BUNDLE,
}, () => {
    // Optional compatibility check against the public game bundle. The bundle
    // stays outside source control; only its camera class and constants execute.
    const bundle = readFileSync(process.env.CAMELKIT_CAMERA_BUNDLE, 'utf8');
    const ast = ts.createSourceFile('game.js', bundle, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const index = ast.statements.findIndex(statement => ts.isClassDeclaration(statement)
        && statement.members.some(member => member.name?.getText(ast) === 'lockedMinRadius')
        && statement.members.some(member => member.name?.getText(ast) === 'applyGameplayView'));
    assert.ok(index > 0, 'Find the native camera class');
    const declaration = ast.statements[index];
    const NativeCamera = new Function(`${ast.statements[index - 1].getText(ast)}; ${declaration.getText(ast)}; return ${declaration.name.text};`)();
    const manager = Object.assign(Object.create(NativeCamera.prototype), {
        camera: { radius: 12, beta: 1.18, lowerRadiusLimit: 8, upperRadiusLimit: 14 },
        lockedRadiusScale: 1, lockedZoomOffset: 0, lockedZoomedOutIntent: false,
        lastLockedAppliedRadius: 12, lastLockedRadiusInitialized: false,
        obstructionAppliedRadius: null, obstructionAppliedBeta: null,
        obstructionIntendedBeta: null, debugZoom: false,
    });
    manager.applyGameplayView();
    const zoom = new CameraZoom(manager, { zoomIn: 25, zoomOut: 300 });
    manager.camera.radius = 40;
    manager.syncLockedRadiusToPitch(true);
    assert.equal(manager.camera.radius, 40);
    manager.camera.radius = 2;
    manager.syncLockedRadiusToPitch(true);
    assert.equal(manager.camera.radius, 2);
    manager.camera.radius = 100;
    manager.syncLockedRadiusToPitch(true);
    assert.ok(manager.camera.radius <= 42);
    manager.setLockedRadiusScale(1.5);
    assert.equal(manager.camera.lowerRadiusLimit, 3);
    assert.equal(manager.camera.upperRadiusLimit, 63);
    zoom.dispose();
    assert.equal(manager.camera.lowerRadiusLimit, 12);
    assert.equal(manager.camera.upperRadiusLimit, 21);
    assert.ok(manager.camera.radius >= 12 && manager.camera.radius <= 21);
});
