# Sunbreak Relay environment

`environment.blend` is the editable Blender source for `public/models/environment.glb`.
The deterministic authoring script reads the current 17 obstacle volumes directly
from `shared/map.ts`. It builds shallow ashlar courses, closed shuttered facade bays,
horizontal tactical-cover panels with fitted end caps, bronze fittings, solar-relay
banners, perimeter planting, cliff strata/outcrops, asymmetric exterior archive/gallery
buildings, and a distant observatory settlement. This geometry was authored for
Kannon Arena. The `sunbreak-art-depth` revision was developed separately from the
frozen `aa469252` release; it preserves that map and runtime group/material contract.

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
and five source previews. `environment-export-review.json` records the actual
exported counts/hash and validation outcome. The validator checks world-axis
conversion, all 17 collision references, 102 visible solid-face samples, four open
tactical routes against every exported mesh, the 4 cm maximum decorative envelope,
exterior vertices staying outside reachable lanes, required PBR maps, foliage cutout
behavior, a single 4,096 m² upward ground layer, and geometry/download budgets.
Two additional outward-winding probes check
the upper archive/pavilion silhouettes. Export also refuses to replace the GLB if it
exceeds 70,000 triangles, 7,000,000 bytes or the fixed 15 batches. These checks do not
establish browser FPS or visual acceptance; inspect the actual running game as well.

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
The petrol finish uses restrained, nondirectional wear from radially filtered
random fields, nearly flat normals, and roughness between 0.43 and 0.60. This
replaces the conspicuous crossed diagonal bands from the former procedural metal
texture. Its random stream is isolated so changing the finish does not alter the
botanical atlas or geometry.
Opaque architecture, cliffs and bark use outward-facing geometry with backface
culling; flower petals also remain double-sided. The olive atlas uses a medium
olive palette with warm variation. The original atlas now contains three connected
botanical sprays per card; its binary alpha coverage is 31.33%. Each mature olive
uses 340 curved cards around one irregular crown and a connected tapered branch
skeleton, versus the earlier 450 cards placed in separate branch clumps. Each
cypress uses 145 cards. There are no opaque canopy filler shells. Explicit
upward/outward normals provide continuous diffuse lighting across the cards without
emission or transmission. Tree planter masonry extends into the surrounding cliff
so the planting does not float above the terrain.
Six additional masonry planters carry rooted bougainvillea stems, soil, connected
leaf sprays and grouped blossoms. They replace the long perimeter row of detached
single leaves. The shrubs remain outside the playable square and avoid the olive
planters; they share the existing stone/bark/leaves/flower batches.

The base and desktop scenery share one asset. 15 material batches and approximately
69k triangles remain below the agreed 70k desktop ceiling. Standard
indexed vertex data and a 7 MB asset ceiling bound the cost. No optional detail GLB
is needed for this first complete scene. Mobile quality can reduce distant scenery,
foliage shadows, reflections, and screen resolution in the renderer.

The latest export is 6,698,732 bytes with 69,484 triangles and 125,761 exported vertices.
Compared with the frozen environment, this is 3,212 more triangles and 237,792 more
bytes, with no added material batches, textures or decoder. The leaf batch decreases
from 26,480 to 18,824 triangles; that budget is redistributed into architectural
framing, branch structure and a shallow paving grid with broad vertex-color wear.
The source limestone/paving artwork and their production PBR textures are retained
unchanged. Counts and
hashes in `environment-export-review.json` are the authoritative build evidence.
The 110 outward-winding probes include all collider faces, upward-facing paving,
the observatory, its cliff, a coastal facade, an olive trunk and the two upper
exterior facades. Opaque materials
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

## Source review and remaining acceptance

`environment-gameplay.png` retains the previous source camera for comparison.
`environment-platform.png` adds a 16:9 view from the south platform; the tall
exterior volumes were moved toward the outer north corners after an initial
preview showed that side-only buildings did not frame this camera. The western
archive has a stepped upper storey; the eastern gallery is lower, with a taller
northern pavilion. `environment-overview.png` exposes roofs, paths and perimeter
placement. Body and coping surfaces are separated to avoid coplanar roof artifacts.
Flush shutter jambs, lintels, pilasters and fittings also use distinct surface
depths within the same 4 cm envelope. This removes the black intersection artifacts
revealed by the material close-up without adding geometry or changing collisions.
`environment-material-detail.png` and `environment-planting.png` inspect the final
metal-finish correction and rooted planting at a scale that the wide views cannot
show clearly.

The surface pass keeps stone dominant on building facades and uses visibly closed
shutters, so dark openings do not suggest usable doors. Cover has a separate
horizontal construction pattern. Paving variation is baked into vertex colors at
the existing Y=0 surface; it adds no decal pass or obstruction. The underlying
slab keeps its sides and bottom, with its side edges meeting the grid at Y=0,
but its hidden upward face is omitted. Leaving
that face under the grid caused two floor-sized shading layers inside one draw.
The validator rejected that regression at 8,192 m² and passes the corrected
single layer at 4,096 m². This correction removes only two hidden triangles and
preserves the visible paving, foliage, all 17 collision volumes and route widths.
The observatory's
original transform is retained, with grounded terrace houses replacing its former
repeated small blocks.

All five Blender previews were inspected. They show source appearance under the
same preview-only lighting, not the game's atmospheric renderer. Gameplay views
from the platform, approaches, all spawn positions and a phone crop are required
for runtime review; release records hold that evidence separately. Sky color is
outside this asset's scope. Constant draw count
does not establish constant GPU cost: denser leaf coverage, larger exterior shadow
silhouettes and additional visible stone still require measurement in the game.
