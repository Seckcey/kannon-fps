# Assets

## Blender source and runtime

- `art/source/scout.blend`: editable Blender 5.2 source.
- `scripts/blender/generate_scout.py`: reproducible generator.
- `scripts/blender/validate_glb.mjs`: GLB structure/budget validation.
- `public/models/scout.glb`: browser model.
- `art/source/`: front/back and action previews plus manifest.

The current sculpted scout export contains 22,654 vertices and 20,868 triangles in 2,658,568 bytes. Four body material batches and three active AR batches are shared across separate player skeletons. The eight-player isolated character scene measured 56 character draws (57 with its test floor), not the complete arena/shadow/postprocessing cost. Reload/heal reaches and grounded jump animation are baked into the original clips and blended in the client; hand-authored motion is not motion capture or world-space foot locking.

The environment has its own editable [Blender source](../art/source/environment.blend), [generator](../scripts/blender/generate_environment.py), [export validator](../scripts/blender/validate_environment.mjs) and [source notes](../art/source/environment-README.md). Geometry is exported in meters, Y up and floor y=0. The validator checks 17 collision reference volumes, 102 visible faces, four open travel lanes, embedded PBR textures, outward-facing opaque surfaces and a 70,000-triangle/7 MB/18-material-batch ceiling. Runtime water and sky are generated separately. Rebuilds replace the GLB atomically.

The final environment in this upgrade contains 66,272 triangles and 116,740 exported vertices in 6,460,940 bytes, with 15 color material batches. Smooth olive leaf cards remain double-sided with alpha masking; closed stone, metal, cliffs and tree trunks use validated outward-facing surfaces. These are original optimized game assets, with an illustrated concept as the target; foliage and architecture still have a simpler silhouette and surface density than that reference.

The original armored scout uses human proportions, an 18-bone skinned rig, separate AR/shotgun/healing attachments, and Idle, Walk, Run, Jump, Aim, Fire, Reload, and Heal clips. Motion is hand-authored, not motion-captured. The manifest records orientation and mesh budget; the client changes the accent material for player identity.

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
