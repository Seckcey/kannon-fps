# Assets

## Blender source and runtime

- `art/source/scout.blend`: editable Blender 5.2 source.
- `scripts/blender/generate_scout.py`: reproducible generator.
- `scripts/blender/validate_glb.mjs`: GLB structure/budget validation.
- `scripts/blender/validate_locomotion.mjs`: exported-skin contact and loop validation, also run by `validate_glb.mjs`.
- `public/models/scout.glb`: browser model.
- `art/source/`: front/back and action previews plus manifest.

The shoulder-polish scout export contains **21,658 vertices and 20,114 triangles in 2,672,192 bytes**. Its SHA-256 is `077be3e5789c136e1607e11cf7d9a243ee4324c44bc92877a3522d706e57bfd0`, served at `/models/scout.glb?v=scout-shoulders-v1`. The fitted shoulder plates and upper-back cloth preserve the V3 skeleton, animations and weapon handling. Four body material batches and three active AR batches use shared geometry/materials with separate player skeletons. Eight visible AR scouts therefore use 56 character draws, excluding arena geometry, shadows and postprocessing. See the [export report](../art/source/scout-export-review.json), [comparison record](SCOUT_MOTION_POLISH.md), and [source notes](../art/source/README.md). The [release record](RELEASE.md) identifies deployed versions separately from this source checkout.

The environment has its own editable [Blender source](../art/source/environment.blend), [generator](../scripts/blender/generate_environment.py), [export validator](../scripts/blender/validate_environment.mjs) and [source notes](../art/source/environment-README.md). Geometry is exported in meters, Y up and floor y=0. The validator checks 17 collision reference volumes, 102 visible faces, four open travel lanes, embedded PBR textures, outward-facing opaque surfaces, a single 4,096 m² upward floor and a 70,000-triangle/7 MB/15-material-batch ceiling. Runtime water and sky are generated separately. Both model generators stage complete exports before replacing their public GLBs atomically.

The V3 environment contains **69,484 triangles and 125,761 exported vertices in 6,698,732 bytes**, with 15 color material batches. Its SHA-256 is `6a0cfc545e49d60519e8a71c933c9048a8aa4dfd7d38687a83b87cace9398d0d`; see the [export report](../art/source/environment-export-review.json). Smooth olive leaf cards remain double-sided with alpha masking; closed stone, metal, cliffs and tree trunks use validated outward-facing surfaces. These are optimized original game assets, with an illustrated concept as the target; foliage and architecture still have a simpler silhouette and surface density than that reference.

The scout uses human proportions, an 18-bone skinned rig, separate AR/shotgun/healing attachments, and Idle, Walk, Run, Jump, Aim, Fire, Reload and Heal clips. Geometry, surfaces, rig, weapon poses and six actions are original Kannon work. Walk/Run lower-body movement derives from the CMU Graphics Lab's `09_01` run capture, frames 15–103 at 120 Hz. Only the selected `09.asf` and `09_01.amc` source files are retained, with [provenance and separate data terms](../art/source/motion/cmu-09/CMU-USAGE-NOTICE.md). The [public model notice](../public/models/scout-motion-NOTICE.txt) ships alongside the GLB. The data permits modification and use in commercial products, but must not be sold directly as motion data or a converted animation pack; it is not CC0 or an original Kannon capture.

The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.

### Movement and verification

The in-place Walk/Run clips are retimed for 6.5/9 m/s and exported at 120 Hz with exact 16/30 and 14/30 second cycles. The other six clips retain their original 30 Hz exported data. Runtime playback follows actual speed, including aimed and slow analog movement. Backward direction uses a small dead band, lower-body turns use world-up while preserving the upper-body aim, and transitions between the two gaits retain matching cycle phase and phase rate. `CharacterBlend` preserves the current weights of all contributing base actions when a transition is interrupted; an already active pose keeps its animation time instead of restarting or jumping to full weight.

During grounded 160 ms pose blends, a two-bone leg constraint checks the actual rigid boot vertices and corrects penetrating ankle targets. It preserves foot orientation and limb lengths without translating the actor, pelvis or upper body. Procedural leg rotations are restored before the next animation evaluation. This fixes blend-induced penetration; it is not a general terrain-following or perfect foot-locking system.

The asset-only validator samples 482 exported poses at 480 Hz. Minimum boot heights are +6.53/+6.31 mm; six unaffected clips match the prior export's Float32 tracks exactly. Conditional contact slip and remaining loop velocity discontinuities are recorded in the [locomotion report](../art/source/scout-locomotion-export-review.json).

A separate V3 browser check through the actual `createBlenderCharacter` controller passed 16 cases and 2,268 samples at 120 Hz, including every initial 160 ms fade. It covered idle/normal/sprint/aim transitions, lateral and backward travel, slow input, moving AR/shotgun reload, healing, returning to ready, fire and repeated stop/start/aim/sprint changes every 50 ms. Minimum sampled clearance was +6.00 mm; support-hand gaps where a grip was expected stayed below 8.89 mm. The loaded model hash matched the V3 artifact and no application errors occurred. This deterministic controller check is separate from real keyboard/touch/network acceptance, rendered motion judgment and performance; it proves neither a physical-phone frame rate nor a two-household playtest.

## Built-in Image Gen assets

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
