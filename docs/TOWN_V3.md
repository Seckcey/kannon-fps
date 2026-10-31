# Kannon Town v3 — checkpoint dressing and golden-hour light, October 30, 2026

Part of the first-person combat overhaul ([design](superpowers/specs/2026-10-30-first-person-combat-overhaul-design.md), section 6; [plan](superpowers/plans/2026-10-30-first-person-overhaul.md), workstream J). The street is the same street: every collision box, spawn, stair route, door and window is where it was, plus the eight new checkpoint cover boxes already frozen in `shared/map.ts`. This release gives those boxes real objects, re-dresses the town as a checkpoint after an evacuation, and re-bakes the light at golden hour.

## What changed

- **Checkpoint cover.** Six stacked sandbag walls (seven courses, three rows, a broken bond, every outer sack bulging 1.5 cm proud of its collision face) and two precast concrete barriers (two units per box, a jersey-style toe and slope, lifting loops, the weathered black-and-white Poly Haven barrier texture). The validator fires a grid of rays at every exposed face and proves the sandbags and concrete sit within a few centimetres of the collision, so there is no invisible lip to shoot into and no visible gap to shoot through.
- **Military cargo truck.** The box truck, in exactly its own boxes: olive cab and drop sides, a canvas cover where the box body was (sewn panels, straps, lashing rope, a rolled rear flap), a divided windscreen with wipers, round headlamps behind guard plates, bumper, tow hooks, mirrors and steps. Its old bright posts and lamp housings are dark.
- **Evacuation bus and a burnt-out car.** The school bus keeps its shape but its paint is faded and grimed toward the road. The north car burned out: charred and rusted body, smoke-blackened glass, a scorch mark spread around it.
- **Dressing.** Ammunition crates stacked four high under a draped tarp where the delivery pile was; plywood boarded over the ground-floor side windows and one upstairs window; concertina wire along the tops of the boundary and yard fences; scorch marks, oil stains, tyre tracks and mud as ground decals; weathered, less saturated house paint and drier lawns; four distant smoke columns beyond the hills.
- **Breakables.** Six window panes in the upstairs street windows (`Breakable_Glass_0..5`) and four terracotta pots with dead plants by the front doors and on the balconies (`Breakable_Pot_0..3`), each its own node and one draw call, listed in `ArenaWorld.breakables` for the effects workstream to shatter. They are cosmetic: shots and players pass through them, and the lower front windows (vault routes) have no glass.
- **Golden hour.** The sun is now 21 degrees up in the west-south-west, warm (`#ffc98f`), and the houses' shadows reach across the street; cool sky light fills the shade; a warm haze softens the hills; clouds are lit from below. Interiors are dim evening rooms that are still easy to fight in.
- **Runtime light that matches the bake.** `src/game/Atmosphere.ts` holds the sun direction, colour and intensity, hemisphere, fog and exposure the bake was made for; the sky shader uses the same sun. Decals draw as multiply decals (they can only darken, and fog fades them out), smoke columns are unlit and sway slowly, window panes are see-through and reflect the street.

## The calibration, and a correction to v2

Cycles bakes the diffuse light pass as irradiance divided by pi (the brightness of a white matte surface), while three.js lightmaps and lights are irradiance. v2 calibrated against a reference plane instead of stating the scale, and its sky ended up about three times stronger relative to the sun than intended, which is part of why v2 looked flat. v3 states the scale (`BAKE_TO_IRRADIANCE = pi`, `blenderToRuntime = SUN_INTENSITY / sun strength`), sets the sky so open sky gives 20 percent of the sun's irradiance, and records what it measured in `art/source/town-v3/town-v3-lightmaps.json`:

| Measured in the bake, three.js units | Value | Runtime |
| --- | --- | --- |
| Sun on a surface facing it | 5.27 / 3.06 / 1.44 (RGB) | `SUN_INTENSITY` 5.2 x `#ffc98f` = 5.20 / 3.04 / 1.43 |
| Open sky on an upward surface | 0.63 / 1.08 / 1.87 | hemisphere `#9ec8ff` x 1.4 plus the sky probe |
| Ground bounce on a downward surface | 0.26 / 0.20 / 0.18 | hemisphere ground `#746762` x 1.4 |
| Sunlit street, upward | 2.36 / 1.92 / 2.01 | (baked only) |

`tests/assets/town-v3-light.test.ts` fails if `Atmosphere.ts` and the bake drift apart: same sun direction and colour, the baked sun within 12 percent of the DirectionalLight, the hemisphere within the baked sky's range and hue, and a low western sun.

## Play and compare

Build the transcoder files once (`node scripts/build-ktx2-worker.mjs`), start the review page with `npm run graphics-test`, and open **http://127.0.0.1:5184/graphics-test.html?graphics=v3**. Before is Kannon Town v2 under its own exposure, fog and daylight; After is v3 under the golden-hour light. Both share the v3 sky dome. Add `&tier=phone` for the phone builds. New views: the checkpoint from both street ends, the cargo truck, the burnt-out car, a barrier, the back-yard sandbags and the long shadows across the street. To capture or measure without the game server, start only the page server (`node node_modules/vite/bin/vite.js --config vite.graphics.config.ts --port 5194 --strictPort`) and run `node scripts/vehicle-test/capture-town-v3.mjs` or `node scripts/vehicle-test/measure-town-v3.mjs`.

Captures from the real renderer (Edge on this machine's integrated GPU, the pre-overhaul third-person GameView, before the effects and grade workstreams land): [all pairs](../art/source/town-v3/captures/captures-sheet.jpg), with cameras and canvases in [captures.json](../art/source/town-v3/captures/captures.json).

| View | Before (v2) | After (v3) |
| --- | --- | --- |
| Checkpoint from the north end | ![](../art/source/town-v3/captures/town-v3-checkpoint-north-before-desktop.jpg) | ![](../art/source/town-v3/captures/town-v3-checkpoint-north-after-desktop.jpg) |
| Long shadows across the street | ![](../art/source/town-v3/captures/town-v3-teal-shadow-before-desktop.jpg) | ![](../art/source/town-v3/captures/town-v3-teal-shadow-after-desktop.jpg) |
| Burnt-out car, wire and crates | ![](../art/source/town-v3/captures/town-v3-burnt-car-before-desktop.jpg) | ![](../art/source/town-v3/captures/town-v3-burnt-car-after-desktop.jpg) |
| Checkpoint, phone tier | ![](../art/source/town-v3/captures/town-v3-checkpoint-north-before-phone.jpg) | ![](../art/source/town-v3/captures/town-v3-checkpoint-north-after-phone.jpg) |

## Measured cost

| Model download | Kannon Town v2 | Kannon Town v3 |
| --- | ---: | ---: |
| Environment, full build, bytes | 25,468,864 | 25,733,708 |
| Environment, phone build, bytes | 12,399,132 | 13,500,260 |
| Triangles | 367,921 | 422,525 |
| Material primitives (draw calls) | 73 | 91 |
| KTX2 images | 140 | 146 |

Full-build SHA-256 `c4a62fe7c97298c6cee5ea259396a8ed2825709f189e4fda08cf4fb50fdc6cc2`, phone build `6a059d79fb075dae9b108656a5d384aed8367b0b8d481e1deb5ddc9b4525b779`. The sandbag walls (432 sacks, about 46,600 triangles) and the wire (about 24,400) add the most; the delivery pile and potted plants they replace give back about 28,000, for 54,600 net. Eighteen new draw calls: ten breakables (one each, so they can shatter separately), decals, smoke, wire and the new material families.

Budgets (validator): full at most 30 MB, phone at most 14 MB, 470,000 triangles, 100 draw calls. The patterned sofa fabric (a 2k texture set used by one sofa) became a plain dusty cover to pay for the new textures; the v3 normal and roughness maps ship at 256 px on phones.

Frame times, Edge 152 on this machine's AMD integrated GPU, fixed views, 20-second samples after a 7-second warm-up, v2 / v3 / v2 brackets on one page ([raw report](../art/source/town-v3/town-v3-performance.json)):

| Configuration, view | FPS v2 / v3 | 95th-percentile ms v2 / v3 | Median GPU ms v2 / v3 | Draws v2 / v3 | Triangles drawn v2 / v3 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Desktop High, bus | 59.9 / 59.9 | 16.8 / 16.8 | 15.5 / 14.9 | 96 / 123 | 356,571 / 417,783 |
| Desktop High, checkpoint | 59.9 / 59.9 | 16.8 / 16.8 | 15.3 / 15.3 | 98 / 124 | 363,706 / 441,038 |
| Phone tier, bus | 59.7 / 59.9 | 16.8 / 16.8 | 4.4 / 4.3 | 73 / 94 | 344,636 / 405,672 |
| Phone tier, checkpoint | 59.9 / 59.9 | 16.8 / 16.8 | 4.4 / 4.8 | 76 / 96 | 356,272 / 435,416 |

Both towns hold the display's 60 Hz on both tiers; the phone tier spends about 0.4 ms more GPU time per frame at the checkpoint. These use the pre-overhaul renderer without the first-person viewmodel, effects or the new grade, and phone means desktop touch emulation at DPR 1.

## Verification

- `node scripts/blender/validate_town_v3.mjs` decodes both shipped files and proves: a guide for every one of the 158 collision boxes at its exact position; v2's witness faces on every other non-vehicle box (861 faces); a 95-ray grid over every exposed face of the eight checkpoint boxes landing on sandbag or concrete within 5 cm in front of and 7 cm behind the collision face for at least 85 percent of rays (the face centres always), and no part of that cover more than 7 cm outside its box; the three re-dressed cover boxes visibly filled from every side; doors, windows and the truck entrance open (breakables ignored, they shatter); six panes in the upstairs street windows and four pots as separate single-draw nodes; smoke more than 120 m away; decals on the ground; decoration in walkable space only on the documented allowance (small props, boarded windows flat to a wall, the pots); lightmaps on the second UV set; KTX2 only; the golden-hour calibration in the manifest; bytes, triangles and draw calls within budget.
- `npx tsx --test tests/client/lightmaps.test.ts tests/client/sun-visibility.test.ts tests/assets/*.test.ts`: lightmap reading and shading, the decal, smoke and glass materials, sun visibility with the long golden-hour shadow across the street, the bake-to-runtime light agreement, and the shipped files' contract (guides for all 158 boxes, breakables, blended and unlit materials, budgets).

## Editable sources and provenance

Blender 5.2.1, Node.js 24+, KTX-Software 4.4 (`ktx` on PATH or `KTX_BIN`, default `C:\it\tools\ktx\bin`):

```powershell
node --import tsx scripts/blender/export_map.ts > art/source/town-v3/map.json
node scripts/blender/run_blender.mjs --python scripts/blender/generate_town_v3.py -- --stage all --samples 128 --atlas 2048
node scripts/blender/finish_town_v3.mjs --input art/source/town-v3/town-v3-raw.glb --lightmaps art/source/town-v3/town-v3-lightmaps.json --out public/models/environment-v3.glb --tier full --manifest art/source/town-v3/environment-v3-manifest.json
node scripts/blender/finish_town_v3.mjs --input art/source/town-v3/town-v3-raw.glb --lightmaps art/source/town-v3/town-v3-lightmaps.json --out public/models/environment-v3-phone.glb --tier phone --manifest art/source/town-v3/environment-v3-phone-manifest.json
node scripts/blender/validate_town_v3.mjs
node scripts/blender/run_blender.mjs --python scripts/blender/generate_town_v3.py -- --stage preview --views checkpoint,truck,south
```

`generate_town_v3.py` starts from `generate_town_v2.py` and the repository's own `kannon-town-graphics.blend`. The bake takes about six minutes at 128 samples on this machine. Working files (the Blender file, raw export, atlases, previews, generated textures) are regenerated under `art/source/town-v3/` and ignored by its own `.gitignore`; the map export, manifests, lightmap sidecar, captures and shipped GLBs are committed.

Third-party material: Poly Haven textures and models, CC0 1.0, listed in `art/source/town-v2/cc0-manifest.json` (no new downloads; the barrier uses the already-fetched `concrete_road_barrier` textures on original geometry). Sandbags, barriers' shape, the truck's canvas and fittings, crates, tarp, wire, pots, boards' layout, decals, smoke and every procedural texture (sacking, canvas, worn paint, fire damage, decals, smoke) are original to the script.

## Limitations

- The captures and measurements use the pre-overhaul GameView, lit through the harness with the `Atmosphere.ts` values. The game itself shows this light only once GameView reads `SUN_COLOR`, `SUN_INTENSITY`, `HEMISPHERE`, `FOG` and `EXPOSURE` from `Atmosphere.ts`.
- Breakables are cosmetic. A player who vaults out through an upstairs pane before anyone shoots it passes through the glass.
- Wire, glass, decals and smoke are not lightmapped. Wire is lit by the real-time sun everywhere; at its size that is not visible.
- Sandbags are lumpy by nature: a few rays on the yard walls land in the seams between sacks, up to 15 cm behind the collision face.
- Golden hour leaves about two thirds of the central street in shade. Players there are lit by the cool sky; the effects and grade workstreams decide the final contrast.
- Phone means desktop Chromium touch emulation, not a physical iPhone.
