# Kannon Town visual overhaul — design

Approved by Frank on 2026-09-09. Decisions: keep Three.js; use purchased and CC0 assets;
stylised-realistic look; phone first; roughly 40 MB total model download; re-skin the existing
scout now and replace it in a later project; map layout, collision, spawns, weapons and rules
do not change.

## Goal

Make Kannon Town look like a finished stylised-realistic mobile shooter instead of a coloured
prototype, on the phone Kannon plays on, without changing how the game plays.

The visible gap today is art density and lighting, not renderer capability: every surface is
one flat colour, the world is empty, there is one uniform sun and a plain sky, and the scout
has no material detail. The renderer already provides physically based materials, ACES tone
mapping, sun shadows, ambient occlusion, baked sky reflections and adaptive resolution.

## Non-goals

- No engine change. No Unity, no native app.
- No change to `shared/map.ts`, `shared/physics.ts`, `shared/protocol.ts`, the server, bots,
  networking, weapons, scoring, spawns or the camera.
- No new scout mesh or rig. The 18-bone rig, eight clips, CMU gait retarget and foot
  constraints stay as they are.
- No real-time global illumination or screen-space reflections. Rich lighting comes from a
  bake, not from per-frame effects.

## Art direction

Stylised realistic: real proportions and materials, clean surfaces with hand-painted-style
detail, slightly lifted saturation, readable silhouettes at phone sizes. Reference points are
Fortnite's environments and Valorant's material treatment, not photoreal Call of Duty.

All purchased packs must share this style. Low-poly flat-shaded packs (Kenney, Synty) and
photoscan packs are out. Poly Haven photo textures are acceptable for large ground and wall
surfaces because they are toned and simplified in Blender before use.

## Assets

### What to acquire

| Need | Source type | Notes |
| --- | --- | --- |
| Modular suburban house kit (walls, roofs, doors, windows, garages, porches, trim) | Purchased, one pack | Must fit two-storey houses with upstairs windows and rear balconies |
| Street and yard props (bins, mailboxes, fences, poles, wires, signs, planters, AC units, tyres, crates) | Purchased, one or two packs | Density is the point |
| Foliage (grass cards, hedges, shrubs, two or three tree types) | Purchased | Cards must work with alpha cutout, not blending |
| Decals (cracks, dirt, leaks, road markings, oil stains) | Purchased or CC0 | Applied as thin geometry in Blender, not runtime projectors |
| Surface textures (asphalt, concrete, siding, brick, roof shingle, grass, soil) | Poly Haven CC0 | Downscaled and toned to the stylised palette |
| Sky | Blender's built-in Nishita sky matched to the runtime sun direction | Drives the bake's sky light; the runtime keeps its existing baked procedural sky. A Poly Haven HDRI is an optional later swap |
| Bus, sedan and truck surfaces | Existing project geometry, new purchased or Poly Haven textures and decals | Existing vehicle geometry is kept |

Budget expectation: a few hundred dollars total. Marketplace candidates are Fab, the Unity
Asset Store, Sketchfab and CGTrader. A pack qualifies only if its licence allows use in a
distributed game in any engine, it ships FBX, OBJ or glTF with ordinary PBR textures (base
colour, normal, roughness, metalness), and it does not depend on engine-specific shaders.
Unity Asset Store packs are acceptable when they ship raw FBX and textures; their licence
allows use outside Unity.

### Provenance record

`art/PURCHASED_ASSETS.md` lists every pack: vendor, product name, licence type, order date,
price, what it is used for, and where the original download is stored outside the
repository. Original purchased archives are not committed. Only the converted, project-specific
Blender scene and exported GLB are committed. CC0 items are listed too with their source URL.
This replaces the current "no third-party assets" statement in `docs/ASSETS.md`.

## Pipeline

### Blender scene

A new hand-authored `art/source/kannon-town-v2.blend` replaces the procedural
`generate_town_graphics.py` as the source of visible geometry. The procedural scripts stay in
the repository for the older environments and as tooling; they no longer generate the shipped
town.

The scene is built on top of the existing collision layout:

1. A script (`scripts/blender/import_collision_layout.py`) reads `shared/map.ts` through the
   existing `export_map.ts` JSON output and creates a locked, non-rendering collection of
   collision boxes, openings, stair routes and spawn markers as guides.
2. Kit pieces are placed by hand so that walkable space matches the guides. The visible
   geometry may sit inside a collision box or add shallow relief outside it; it never
   intrudes into walkable space by more than the existing tolerance used by
   `validate_town_graphics.mjs`, and every collision box is covered by visible geometry so
   players never hit invisible walls.
3. Openings (eight house openings, garage doors, upstairs windows, the truck entrance) are
   kept clear, as today.
4. Props are placed for density and readability, never inside routes. Anything a player
   could stand on must sit on an existing collision box; decorative props are marked
   non-blocking and live outside routes.

### Lightmap bake

Every static environment object gets a second UV set (`TEXCOORD_1`) unwrapped for lightmaps
using Blender's lightmap pack, grouped into a small number of lightmap atlases (target four
2048 atlases, phone build downscaled to 1024). Blender Cycles bakes combined diffuse
lighting (sun plus Nishita sky plus bounce) to those atlases. Direct sunlight is included in the
bake, so the environment needs no real-time shadow map on phones.

A **sun-visibility probe** keeps characters consistent with the baked world: a player standing
in baked shade must not be lit as if in the open. The probe is not baked in Blender. The
browser computes it once when the world loads by casting rays from a 64×64 grid over the play
area, at chest height on two layers (ground level and upper floor), toward the sun using the
existing `raycastMap` in `shared/physics.ts`. The runtime samples it per character to scale
the real-time sun on that character. Collision boxes approximate the same buildings the bake
sees, so the two agree closely, and there is no extra download.

`scripts/blender/bake_town_v2.py` runs the unwrap and the bake headlessly and is the
reproducible source of the lightmaps.

### Export and compression

`scripts/blender/export_town_v2.py` exports the GLB. Because the glTF format has no lightmap
slot, a Node post-processing step (`scripts/blender/finish_town_v2.mjs`, using
`@gltf-transform/core`) attaches each material's lightmap through a project extension
`KANNON_lightmap` (`{ index, texCoord: 1, intensity }`) and then:

- resizes textures to the tier budget (2048 for hero surfaces, 1024 for props, 512 for
  small items),
- compresses all textures to KTX2 (UASTC for normal maps, ETC1S for colour, roughness and
  lightmaps),
- applies Meshopt as today,
- writes `environment-v2.glb` plus a manifest with per-texture sizes and the SHA-256.

Runtime loading uses `KTX2Loader` from Three.js with the bundled Basis transcoder served
from the site's own origin. The existing Content Security Policy already allows the
project's own WebAssembly; the transcoder is added to the same allowance.

### Scout re-skin

`scripts/blender/scout_textures.py` bakes a new 2048 PBR set (base colour, normal,
roughness/metalness, emissive) onto the existing scout UVs from a Blender material graph
built with purchased or Poly Haven surfaces: contoured armour with edge wear, woven charcoal
fabric, a reflective visor with a narrow emissive strip, and player-identification strips on
the pack. UV layout is checked for overlap first; if the current UVs overlap, the script
re-unwraps a copy of the mesh without changing vertex order, bones or clips, and the existing
locomotion and grip validators are re-run unchanged to prove the skin still matches.

The scout GLB moves to `scout-v2.glb` with KTX2 textures, targeting 5 MB.

### Budgets

| Item | Target |
| --- | --- |
| Environment GLB | 30 MB or less |
| Scout GLB | 5 MB or less |
| Transcoder and decoders | 1 MB or less |
| Total first-load models | 40 MB or less, cached afterwards |
| Environment triangles | 400,000 or less |
| Draw calls, phone tier, fixed bus view, one scout | 60 or less |
| Phone tier frame time, touch-emulated 852×393, 95th percentile | 16.8 ms or less |
| Desktop High, 1280×720, integrated AMD GPU | 30 FPS or more median |

## Runtime rendering

### Loading

`src/game/assets.ts` learns the two new URLs and the new transcoder dependency, keeping its
byte cache, abort deadlines and version gating. `src/game/World.ts` registers `KTX2Loader`,
reads the `KANNON_lightmap` extension through a `GLTFLoader` plugin and assigns
`material.lightMap` with `lightMapIntensity`. Materials without a lightmap (foliage cards,
decals, vehicles' glass) keep ordinary lighting.

### Tiers

The existing `auto | high | low` setting and `RenderQuality` adaptive resolution stay.
What each tier does changes:

| Feature | Phone (auto on touch, low) | Desktop auto | Desktop high |
| --- | --- | --- | --- |
| Environment lighting | Lightmap plus HDRI reflections | Same | Same |
| Environment real-time shadows | Off | Off | Off (baked) |
| Character shadows | One 1024 shadow map, camera-tight frustum following the local player, environment receives | Same, 2048 | Same, 2048 |
| Sun on characters | Scaled by the sun-visibility probe | Same | Same |
| Ambient occlusion | Baked only | Baked plus existing GTAO contact pass | Same |
| Bloom | Off | Soft bloom on visor, lamps, muzzle flash | Same |
| Anti-aliasing | Hardware MSAA where available | SMAA | SMAA |
| Colour grade | Fixed ACES exposure | LUT grade | LUT grade |
| Fog | Linear distance fog, tinted to the sky | Same | Same |
| Grass cards | Sparse, no wind | Medium, wind | Dense, wind |
| Texture tier | 1024 lightmaps, 1024 hero, 512 props | Full | Full |

Phone texture tier is selected by serving a second, smaller environment GLB
(`environment-v2-phone.glb`) rather than by downloading full-size textures and discarding
detail. Both files come from the same Blender scene and the same finish script with a size
parameter.

### Presentation

`src/game/Presentation.ts` grows from one contact pass into a small desktop stack: render,
GTAO contact pass (existing), bloom, LUT colour grade, SMAA, output. Phones never load this
module, as today. The LUT is a 32×32×32 PNG authored once in Blender's colour management to
lift saturation and warm the highlights in line with the art direction.

### Foliage

Grass and shrub cards are exported as ordinary meshes and instanced at runtime with
`InstancedMesh` from a scatter table stored in the GLB's extras, so the GLB stays small and
density is a runtime tier choice. A small vertex shader adds wind on desktop tiers.

## Verification

Evidence stays real-renderer captures and measured numbers, as in `docs/TOWN_GRAPHICS.md`.

- `scripts/blender/validate_town_v2.mjs` decodes the shipped GLB and proves: every collision
  box is covered by visible geometry; no visible triangle intrudes into walkable space beyond
  tolerance; all openings and the truck entrance remain clear; triangle, texture, draw and
  byte budgets hold; every material referenced by the lightmap extension has `TEXCOORD_1`.
- The existing graphics comparison page gains a Kannon Town v2 mode with the same fifteen
  fixed views, so before and after captures use identical cameras and settings.
- The performance report is re-run on the phone tier at 852×393 touch emulation and on
  desktop High, with adaptation locked, using the same procedure as the previous release.
- The scout locomotion, grounded and grip validators run unchanged against `scout-v2.glb`.
- Existing rule, client and transport tests, TypeScript, production build and the security
  header check continue to pass. A test covers the lightmap extension plugin and the tier
  table.
- A physical iPhone check remains a separate acceptance gate, recorded honestly as done or
  not done.

## Delivery order

1. Asset selection and purchase, provenance record, style test: one house corner and the
   road with real textures and a bake, captured in the real renderer, to confirm the look
   before building the whole town.
2. Runtime foundations: KTX2 loading, lightmap extension, sun-visibility probe, tier table,
   phone GLB variant. Proven on the style test scene.
3. Full town build in Blender, bake, export, validator.
4. Scout re-skin.
5. Desktop presentation stack, foliage instancing, fog and grade.
6. Comparison captures, performance runs, docs, release.

Step 1 is a real checkpoint: if the purchased kit cannot match the collision layout or the
style test does not look right, stop and revisit before spending on the full build.

## Risks

- **Kit fit.** Purchased modules use their own grid; house footprints may not match the
  collision boxes exactly. Mitigation: fit visible geometry to collision, never the reverse;
  accept shallow relief; the validator enforces it.
- **Format conversion.** FBX to Blender import can lose material assignments or flip
  normals. Every pack is imported, checked and re-materialled before use.
- **Lightmap seams and bake time.** Mitigated by atlas padding and dilation; bake runs
  headless and is reproducible.
- **Phone memory.** KTX2 textures stay compressed on the GPU, which is the main reason to use
  them; the phone GLB variant halves texture memory again. iPhone Safari is still the
  unknown until tested on a device.
- **Style drift.** Poly Haven photo textures can pull the look toward photoreal. They are
  toned and simplified in Blender and judged against the style test before wide use.
