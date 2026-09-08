# Original Kannon Scout

`scout.blend` is the editable Blender 5.2 source for the character in
`public/models/scout.glb`. All geometry, surfaces, the armature, and motion were
authored for Kannon Arena. No external character or motion-capture asset was used.

The scout has anatomically proportioned limbs, shaped tactical undersuit, ceramic
armor, an enclosed helmet, layered pack, gloves and boots, and modeled assault
rifle, shotgun, and healing item. This is original game art with authored movement;
it is not photorealistic scanned art or motion capture.

## Rebuild and inspect

From the repository root:

```sh
blender --background --python scripts/blender/generate_scout.py
blender --background --python scripts/blender/validate_scout.py
node scripts/blender/validate_glb.mjs
```

The generator saves the Blender source, exports the game asset, and renders front
and back studio views. The Blender validation checks skin weights and renders Run,
Reload, and Heal frames. The binary glTF validation checks attachment names,
animations, the geometry budget, packed textures, and the muzzle's world position.

## Runtime contract

- Metres, feet at ground level, approximately 1.84 metres tall including the helmet.
- Exported axes: Y up, forward -Z. Blender source uses Z up and forward +Y.
- One 18-bone skeleton named `ScoutRig`; torso has blended skin weights; armor is
  weighted to its corresponding body segment.
- Named clips: `Idle`, `Walk`, `Run`, `Jump`, `Aim`, `Fire`, `Reload`, `Heal`.
- Walk and Run are in place. The game moves the root; authored pelvis adjustment
  keeps the boots close to the ground. Jump's world height comes from game physics.
- Separate skinned meshes/groups: `weapon_ar`, `weapon_shotgun`, `healing_item`.
  Show only the active slot. The AR muzzle attachment is named `muzzle`.
- `PlayerAccent` is the team/player-color material; `Visor` is the helmet visor.
- `chest` is the upper-body bone. Exported bone rest rotations must be preserved
  when applying runtime aiming offsets.
- The exporter samples full skeletal tracks. For layered recoil or reload while
  moving, filter action tracks to upper-body bones in the animation mixer so a
  neutral lower-body track does not override locomotion.

See `scout-export-review.json` for exported counts, rather than Blender's smaller
pre-export vertex count. Normals and material seams split vertices during export.
All surface images are packed into the GLB; no external texture request is needed.
