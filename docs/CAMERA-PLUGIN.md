# Camera plugin

Open the **📷 Camera** sidebar tab after logging into CamelKit.

- **Zoom-in limit:** 25–100% of the game's normal closest distance. Lower values allow a closer view.
- **Zoom-out limit:** 100–300% of the game's normal farthest distance. Higher values allow a wider view.
- **Reset zoom limits:** restores both values to 100%.

Use the sliders or type a percentage and leave the field to apply it. Scroll over the game to zoom as usual. CamelKit saves these preferences through its existing plugin settings system. They are also available under the Camera plugin in Settings.

The plugin retains the game's pitch controls, viewport scaling, and obstruction handling. Camera collision may temporarily bring the view closer around scenery. Disabling Camera restores the native limits. A replacement camera after a login or world change picks up the configured limits automatically.

## Validation

From the repository root:

```powershell
node --test packages/client/tests/cameraZoom.test.mjs
pnpm --filter @camelkit/client build
```

The test suite can additionally check the native camera calculations from a locally downloaded public game bundle by setting `CAMELKIT_CAMERA_BUNDLE` to its path. No game code or login credentials are stored in the repository.
