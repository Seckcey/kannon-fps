# Sunbreak Relay environment

`environment.blend` is the editable Blender source for `public/models/environment.glb`.
The deterministic authoring script reads the current 17 obstacle volumes directly
from `shared/map.ts`. It builds individual shallow ashlar courses, architectural
pilasters, closed petrol-teal equipment panels, bronze fittings, solar-relay banners,
perimeter planting, cliff strata/outcrops, coastal auxiliary buildings, and a distant
domed observatory. This geometry was authored for Kannon Arena.

The limestone and paving basecolor artwork comes from the built-in Image Gen tool:
`materials/sunbreak-limestone-v2.png` and `materials/sunbreak-paving-v2.png`.
The generator preserves those source images and packs resized JPEG basecolors,
authored normal/roughness estimates, original metal maps, and an original botanical
leaf atlas. These are game materials, not scanned physically measured surfaces.

## Rebuild and verify

```sh
blender --background --python-exit-code 1 --python scripts/blender/generate_environment.py
node scripts/blender/validate_environment.mjs
```

The build saves an editable compressed `.blend`, its complete GLB, a manifest,
and two source previews. `environment-export-review.json` records the actual
exported counts/hash and validation outcome. The validator checks world-axis
conversion, all 17 collision references, 102 visible solid-face samples, four open
tactical routes, the 4 cm maximum decorative envelope, required PBR maps, foliage
cutout behavior, and geometry/download budgets. It does not establish browser FPS
or visual acceptance; inspect the actual running game as well.

## Runtime contract

Add the GLB scene at identity. Coordinates are already baked in metres, Y up, with
the playable ground at Y=0. Named groups are `ArenaCore`, `ArenaTrim`, `Exterior`,
`Foliage`, `Horizon`, and metadata-only `CollisionReferences` beneath `Environment`.
No camera, light, water, animation, or collision implementation is exported.

Materials are `EnvLimestone`, `EnvGround`, `EnvPetrol`, `EnvBronze`, `EnvCliff`,
`EnvBark`, `EnvLeaves`, and `EnvFlower`. The first three have packed basecolor,
normal, and roughness/metalness maps. Stone basecolors are 1024 px, their normals 512 px,
roughness packs 256 px, metal maps 256 px, and the botanical atlas 512 px. All images are
embedded; vertex tints use standard normalized 8-bit glTF colors and require no
additional decoder. `EnvLeaves` is double-sided alpha MASK with cutoff 0.5.
Opaque architecture, cliffs and bark use outward-facing geometry with backface
culling; flower petals also remain double-sided. The olive atlas uses a medium
olive palette with warm variation. Explicit upward/outward canopy normals provide
continuous diffuse lighting across leaf cards without emission or transmission.

The base and desktop scenery share one asset. 15 material batches and approximately
66k triangles provide denser botanical foliage and geological relief than the
initial 45k proposal while remaining below the agreed 70k desktop ceiling. Standard
indexed vertex data and a 7 MB asset ceiling bound the cost. No optional detail GLB
is needed for this first complete scene. Mobile quality can reduce distant scenery,
foliage shadows, reflections, and screen resolution in the renderer.

The latest export is approximately 6.46 MB with 117k exported vertices. Counts and
hashes in `environment-export-review.json` are the authoritative build evidence.
The 108 outward-winding probes include all collider faces, upward-facing paving,
the observatory, its cliff, a coastal facade and an olive trunk. Opaque materials
cannot hide reversed surfaces at those samples behind double-sided rendering.
Irregular landmark outcrops and smoothly shaded island rings break up uniform
cliff bands; split rock-face vertices retain their angular fracture edges.

The sea is rendered separately at approximately Y=-9 to reveal the coastal strata.
`Horizon` should not cast arena shadows. Tree trunks and decorative buildings are
outside the 64 m playable square; higher tree canopies may overhang. The playable
building rooftops remain flat because that is the authoritative collision surface.
The north lintel, 11 m gate opening, 6.5 m center route, 9 m outside flanks, and existing
steps/spawns remain unchanged. Exterior architecture supplies taller silhouettes
without inventing uncollidable gameplay cover.
