# Assets

## Third-party assets

Third-party assets are permitted from the visual overhaul onward. Every purchased or CC0 item is
recorded in [art/PURCHASED_ASSETS.md](../art/PURCHASED_ASSETS.md) with its licence, source and
local archive location before use. Earlier releases used only original project artwork; their
sections below still describe that work.

## Blender source and runtime

- `art/source/scout.blend`: editable Blender 5.2 source.
- `scripts/blender/generate_scout.py`: reproducible generator.
- `scripts/blender/scout_grounded.py`: offline support, loop and knee-plane refinement for Walk/Run.
- `scripts/blender/validate_glb.mjs`: GLB structure/budget validation.
- `scripts/blender/validate_locomotion.mjs`: exported-skin contact and loop validation, also run by `validate_glb.mjs`.
- `public/models/scout.glb`: browser model.
- `art/source/`: front/back and action previews plus manifest.

The current grounded-gait scout export contains **21,658 vertices and 20,114 triangles in 2,679,764 bytes**. Its SHA-256 is `9b668768f6b47569f31a8f32c606a9a79e465c16cdcbe55b1e1d3ffa9e0108c9`, served at `/models/scout.glb?v=scout-grounded-v1`. It retains the fitted shoulder geometry, 18-bone rig and equipment while refining Walk/Run pelvis and leg animation. The other six clips preserve their prior Float32 tracks exactly. Four body material batches and three active AR batches use shared geometry/materials with separate player skeletons. Eight visible AR scouts therefore use 56 character draws, excluding arena geometry, shadows and postprocessing. See the [current locomotion report](../art/source/scout-locomotion-export-review.json), [six-clip comparison](../art/source/scout-locomotion-migration-review.json), [historical shoulder release](SCOUT_MOTION_POLISH.md), and [source notes](../art/source/README.md). The [release record](RELEASE.md) identifies deployed versions separately from this source checkout.

The current environment is the [September 9 town graphics release](TOWN_GRAPHICS.md), with editable `art/source/kannon-town-graphics.blend`, generator `scripts/blender/generate_town_graphics.py` and runtime `environment-refined.glb`. Its decoded geometry, protected vehicles/truck and collision references are checked by `validate_town_graphics.mjs`; the source recipe and licensing are documented in that release.

The retained original baseline has editable [Kannon Town Blender source](../art/source/kannon-town.blend), a [generator](../scripts/blender/generate_town.py), an [export validator](../scripts/blender/validate_environment.mjs), and [map notes](KANNON_TOWN.md). Geometry is exported in meters, Y up, with floor y=0. The generator reads the shared map, stages a complete GLB, then replaces the public model atomically. `generate_environment.py` and `environment.blend` are historical Sunbreak sources; do not use that generator for the current map.

The original Kannon Town baseline contains **31,308 triangles and 62,188 exported vertices in 3,922,392 bytes**, with 13 material batches and 13 embedded textures. Its SHA-256 is `10bc88dfbf95e878225f60ed620bae0a8786ef8176f442f1dff15e39d1b62723`, served as `/models/environment.glb?v=kannon-town-v1`. The [export review](../art/source/town-export-review.json) checks 150 collision volumes and all 900 rendered faces, open doors/windows and truck access, finite normals/UVs/vertex colors, and 70,000-triangle/7 MB/18-batch ceilings. The original generated asphalt albedo and Blender-produced material sources are retained under `art/source/town-materials`. The [concept](art/kannon-town-concept.png) establishes sunny neighborhood colors; geometry and surface density are intentionally simpler for browser use. The runtime sky is retained and the former ocean surface is removed.

The scout uses human proportions, an 18-bone skinned rig, separate AR/shotgun/healing attachments, and Idle, Walk, Run, Jump, Aim, Fire, Reload and Heal clips. Geometry, surfaces, rig, weapon poses and six actions are original Kannon work. Walk/Run lower-body movement derives from the CMU Graphics Lab's `09_01` run capture, frames 15–103 at 120 Hz. Only the selected `09.asf` and `09_01.amc` source files are retained, with [provenance and separate data terms](../art/source/motion/cmu-09/CMU-USAGE-NOTICE.md). The [public model notice](../public/models/scout-motion-NOTICE.txt) ships alongside the GLB. The data permits modification and use in commercial products, but must not be sold directly as motion data or a converted animation pack; it is not CC0 or an original Kannon capture.

The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.

### Movement and verification

The in-place Walk/Run clips are retimed for 6.5/9 m/s and exported at 120 Hz with exact 16/30 and 14/30 second cycles. The other six clips retain their original 30 Hz exported data. Runtime playback follows actual speed, including aimed and slow analog movement. Backward direction uses a small dead band, lower-body turns use world-up while preserving the upper-body aim, and transitions between the two gaits retain matching cycle phase and phase rate. `CharacterBlend` preserves the current weights of all contributing base actions when a transition is interrupted; an already active pose keeps its animation time instead of restarting or jumping to full weight.

The offline `scout_grounded.py` pass samples the retimed poses at 240 Hz. It retains baseline contact masks and follows the same sole material point across each support interval, accounting for foot roll and forward travel. A constant 4 cm animated pelvis drop supplies knee flexion; actor/root position and gameplay movement remain unchanged. Fixed-length leg solves retain foot orientation and the repaired height profile, with a 5 mm extension reserve. Reach limits cover both support and the 30 ms Hermite return during flight, with horizontal correction bounded to 8 cm. A short 16.667 ms repair on either side of the loop boundary reduces velocity changes; confidence-weighted circular filtering stabilizes captured knee planes near extension. Upper-body local curves, rig geometry and the six other actions are outside this pass. Aggregate solve errors are always recorded; set `KANNON_GAIT_DIAGNOSTICS=1` during generation for detailed per-frame diagnostics.

During grounded 160 ms pose blends, a two-bone leg constraint checks the actual rigid boot vertices and corrects penetrating ankle targets. It preserves foot orientation and limb lengths without translating the actor, pelvis or upper body. Procedural leg rotations are restored before the next animation evaluation. This fixes blend-induced penetration; it is not a general terrain-following or perfect foot-locking system.

The asset-only validator samples 482 exported poses at 480 Hz. Minimum boot heights are +6.54/+6.46 mm. The current [locomotion report](../art/source/scout-locomotion-export-review.json) records the following conditional horizontal-slip measurements; contact bands exclude penetration.

| Contact band | Walk median / 95th percentile | Run median / 95th percentile | Walk / Run contact duty |
| --- | --- | --- | --- |
| 20 mm | 0.030 / 0.105 m/s | 0.175 / 0.622 m/s | 32.4% / 28.6% |
| 40 mm | 0.033 / 0.441 m/s | 0.176 / 1.580 m/s | 53.5% / 45.5% |

Sampled loop positions coincide, but endpoint velocity differences remain 0.95/1.53 m/s. These are substantial support improvements, not perfect forefoot locking or seamless joint velocity. Reverse foot-roll drift and acceleration still require separate evaluation; asset-only sampling does not establish runtime transition behavior.

The [final-model controller check](verification/scout-grounded-controller.json) passed 16 cases and 2,268 samples at 120 Hz through the actual `createBlenderCharacter`, including every initial 160 ms fade. It covered idle/normal/sprint/aim transitions, lateral and backward travel, slow input, moving reload/heal/fire and repeated changes every 50 ms. Requested, loaded and final hashes matched `9b668768...`; minimum clearance was +6.00 mm and expected support-hand gaps stayed below 8.89 mm. No application errors occurred; the known sky shader precision warning remains recorded. This deterministic check is separate from real input, networking, rendered motion judgment and performance. It establishes neither a physical-phone frame rate nor a two-household playtest.

## Built-in Image Gen assets

The current map concept and menu artwork are `docs/art/kannon-town-concept.png` and `public/assets/kannon-town-lobby.png`. `art/source/town-materials/asphalt-generated.png` is the original generated asphalt albedo retained with the baseline Blender materials. All were made with the built-in Image Gen tool. The following Sunbreak entries describe retained historical sources.

| Path | Use |
| --- | --- |
| `docs/art/lobby-concept.png` | Complete 1536×1024 menu reference |
| `docs/art/gameplay-concept.png` | 1536×1024 third-person/HUD direction |
| `public/assets/sunbreak-lobby.png` | Standalone menu illustration |
| `public/assets/limestone.png` | Retained stone material from the first playable pass |
| `docs/art/sunbreak-v2-concept.png` | Detailed coastal observatory/scout visual target |
| `art/source/materials/sunbreak-limestone-v2.png` | Original generated base-color source for Blender architecture |
| `art/source/materials/sunbreak-paving-v2.png` | Original generated paving base-color source |

The earlier `public/assets/limestone.png` is retained source from the first playable pass; the new environment embeds its own packed materials. Exact original prompts and material-reference paths for the new generation are preserved in [sunbreak-v2-prompts.json](art/sunbreak-v2-prompts.json). Blender derives surface normal/roughness maps and packs optimized images into the GLB. Requested image dimensions in the prompt record are not represented as guaranteed output dimensions.

All used the built-in Image Gen tool, with no API-key fallback. They are original generated images, not Fortnite assets. Real UI text and controls are native HTML; a screenshot is never used as the game interface.

### Production prompt set

**Menu illustration:** Standalone 1536×1024 background based on the lobby concept. Preserve the original helmeted cream/orange competitor, rifle down, sunny coastal courtyard, sea, pines, and peach/cream structures. Remove all menu text, navigation, panels, buttons, and HUD. Competitor center-right around 66% of width, helmet around 15%, feet near 98%; quiet navy left 35% for HTML. Bright sky at right, natural left-edge fade into #061521. No copyrighted game characters.

**Limestone:** Square seamless tileable diffuse/albedo ivory limestone slabs, flat orthographic view, no shadows/directional lighting/objects. Large subtle slabs, thin sand grout, restrained porous cream detail, worn edges, slight peach flecks, #e8dcc3 base. No text/logos/UI.

### Concept prompts

Complete KANNON ARENA lobby with Play/Leaderboard/How to play/Settings, “Your crew. Your arena.”, “Good rivals. Great games.”, Player name, Create private match, Join with invite, Practice first, 2–8 players/five minutes/first to 15, and AR/shotgun/heal slots. Navy #111d2b, chartreuse #d7ff5b, seafoam/warm white, condensed athletic typography, open spacing, angled actions; original sunny coastal armored character.

Gameplay direction used the same palette/environment, an over-the-shoulder character, crosshair, score/timer, health/shield, slots/ammo, and roster. Free-look Blender/Three.js models intentionally replace fixed raster game sprites. Model/environment detail is lighter than the illustration to support phones and remains an early art pass.

## Fonts and icons

Barlow/Barlow Condensed are bundled locally through Fontsource with license files in their packages. Small interface/weapon SVG silhouettes are original. No remote font, tracking, or game asset service is required at runtime.
