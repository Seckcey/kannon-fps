# Original Kannon Scout

`scout.blend` is the editable Blender 5.2 source for the character in
`public/models/scout.glb`. All geometry, surfaces, the armature, and motion were
authored for Kannon Arena. No external character or motion-capture asset was used.

The Sunbreak scout has anatomically proportioned limbs, shaped charcoal undersuit,
contoured ivory ceramic plates, a reflective enclosed helmet, a fixed petrol-teal service pack,
restrained bronze fittings, gloves and boots, and modeled assault rifle, shotgun,
and healing item. The support hand reaches the weapon fore-end; reload and heal
reaches are solved in Blender and baked into the existing skeleton. This is original game art with authored movement;
it is not photorealistic scanned art or motion capture.

## Rebuild and inspect

From the repository root:

```sh
blender --background --python scripts/blender/generate_scout.py
blender --background --python scripts/blender/validate_scout.py
node scripts/blender/validate_glb.mjs
```

The generator saves the Blender source, exports the game asset, and renders front
and back studio views. The Blender validation checks skin weights, checks boot
clearance across every Walk and Run frame, renders Run/Reload/Heal frames and a
geometry-based eight-pose contact sheet. The binary glTF validation checks
attachment names, animations, geometry/material budgets, the packed PBR atlas and
its UV channel, weapon grips, and both muzzles' world positions.

## Runtime contract

- Metres, feet at ground level, approximately 1.84 metres tall including the helmet.
- Exported axes: Y up, forward -Z. Blender source uses Z up and forward +Y.
- One 18-bone skeleton named `ScoutRig`; torso has blended skin weights; armor is
  weighted to its corresponding body segment.
- Named clips: `Idle`, `Walk`, `Run`, `Jump`, `Aim`, `Fire`, `Reload`, `Heal`.
- Walk and Run are in place with contact, compression, passing, toe-off and recovery
  poses. The game moves the root; authored pelvis adjustment keeps the boots close
  to the ground. This verifies vertical clearance, not world-space foot locking.
  Runtime gait cadence follows velocity; backward movement reverses the gait, and
  the lower body turns toward lateral travel while the chest keeps facing the aim.
  Jump's world height and grounded state come from game physics.
- Separate skinned meshes/groups: `weapon_ar`, `weapon_shotgun`, `healing_item`.
  Show only the active slot. Muzzle attachments are `muzzle` for AR and
  `muzzle_shotgun` for the longer shotgun barrel.
- `PlayerAccent` is the team/player-color material; `Visor` is the helmet visor.
- Player color appears on shoulder and hip identifiers and narrow rear strips;
  the main pack stays petrol teal for a consistent silhouette across the roster.
- `chest` is the upper-body bone. Exported bone rest rotations must be preserved
  when applying runtime aiming offsets.
- The exporter samples full skeletal tracks. Runtime filters Fire/Reload/Heal to
  the upper body, converts them into additive deltas from their neutral first
  frame, and plays them over locomotion. Reload/Heal play once, scaled to the
  server's action duration; the shotgun no longer loops an AR-length reload.
- `ScoutSurface` packs ceramic, textile, rubber and metal responses into one
  1024x512 base-color/normal/metal-roughness atlas. PlayerAccent, Visor and emissive
  status lights remain separate. The body uses four draws and the active AR three.
- Each player shares one bone palette across its body and equipment primitives;
  geometry/textures remain shared between players, with separate player colors.

See `scout-export-review.json` for exported counts, rather than Blender's smaller
pre-export vertex count. Normals and material seams split vertices during export.
All surface images are packed into the GLB; no external texture request is needed.

## Sunbreak verification

The revised export has 22,654 vertices, 20,868 triangles and a 2.66 MB GLB, retaining
all 18 bones and eight clips. The boot-clearance review covers 42 gait frames.
Chrome rendering of eight visible AR scouts uses 56 character draws (57 with the
test floor), with shared bone palettes reducing the isolated scene from 68 to 16
textures. These counts exclude arena geometry and shadow passes; they are not a
physical-phone frame-rate claim. Runtime review images are named
`scout-runtime-front.png`, `scout-runtime-back.png`, and `scout-runtime-eight.png`.
