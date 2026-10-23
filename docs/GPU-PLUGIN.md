# GPU plugin

Open **🖥️ GPU** in CamelKit's sidebar after logging in.

- **Draw distance:** 24–128 tiles around the player. The plugin starts at 72 tiles; the current game's normal view is 36 tiles.
- **Game fog:** uses the current map/biome's authored fog.
- **Custom fog:** adjusts fog start and end as percentages of draw distance. The default transition is 65–100%.
- **Off:** removes the visual fog while keeping world loading and culling bounded by draw distance.
- **Reset GPU settings:** restores the plugin's defaults. Disable GPU in CamelKit Settings to restore the game's native rendering settings.

Use sliders or type numbers and leave the field to apply them. Preferences use CamelKit's existing per-player plugin settings storage. Fog controls are also available in CamelKit Settings.

The plugin coordinates terrain/scenery loading, entity visibility, player-centered fog, and the camera's far clip plane. Camera zoom and pitch continue to update the clip plane normally. It preserves fog colors, biome transitions, and the native Low GPU mode's 30-tile cap. Larger views load more chunks and can increase rendering and memory costs; newly requested scenery can take time to appear. It does not create entities or terrain unavailable from the game server, or change interaction distances.

The plugin waits for login and map bootstrap to finish before changing rendering. If a distant chunk request returns 404 for a fixed map-content generation, the GPU panel reports it and pauses repeated requests for that chunk. The first native warning stays in the log. Nearby chunks retain normal retries. Missing terrain is not marked loaded or walkable, and missing scenery is not declared empty. Temporary failures retain normal retries. **Retry unavailable map chunks** allows a manual retry; movement into another 32-tile region or a new map load clears the missing-chunk cache. Disabling GPU removes the request observer and restores native retry behavior.

## Verification

From the repository root:

```powershell
node --test packages/client/tests/gpuRendering.test.mjs
pnpm --filter @camelkit/client build
```

Optional compatibility tests read locally downloaded public game bundles. Set `CAMELKIT_GPU_GAME_BUNDLE` to the main game-manager bundle and `CAMELKIT_GPU_CHUNK_BUNDLE` to its world-chunk module. Those files and any test previews remain outside source control.
