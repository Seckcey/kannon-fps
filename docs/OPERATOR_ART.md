# Operator character art

The operator is the soldier you see when you look at other players in the first-person overhaul.
It replaces the bright armoured scout with dark modern military gear. It keeps the scout's
skeleton and every gameplay animation the client already plays, so the code that drives the scout
drives the operator. It adds three new animations: crouch, crouch walk and slide.

Everything in the model is original Kannon work: the gear shapes, the four-tone camouflage, the
colours and the new animations. Nothing is copied from a game, a brand or a real army, and no
textures or models were downloaded. The only outside material is the scout's existing walk and run
leg motion, which comes from the CMU motion capture database (see [Credits](#credits)).

| Front, friendly blue | Back, enemy red |
| --- | --- |
| ![Operator front](../art/source/operator-front.png) | ![Operator back](../art/source/operator-back.png) |

![All clips](../art/source/operator-poses.jpg)

![Crouch, crouch walk and slide from the side](../art/source/operator-low-poses.jpg)

These are Blender studio renders of the exported pose data, not browser captures.

## What it looks like

- **Head.** A high-cut helmet in dark olive paint with side rails, a front mount plate, hook-and-loop
  patches, a counterweight pouch and two bungee cords. A dark knit wrap is pulled up over the nose,
  with wraparound dark glasses and a headset with a boom microphone. No face is shown.
- **Plate carrier.** Ranger green, shaped to the chest and back, with 25 mm webbing rows, a side
  cummerbund, padded shoulder straps, three coyote magazine pouches with closed flaps, an admin
  pouch, a flat back panel with a zip, a radio with an aerial and a drag handle.
- **Clothes.** Combat shirt and trousers in an original four-tone camouflage, a shirt collar, knee
  pads, cargo pockets, a padded belt with pouches, dark gloves with knuckle guards and coyote boots
  with dark soles. Lower legs and boots carry a little street dust.
- **Team colour.** `PlayerAccent` covers both armbands, both shoulder patches, a chest patch, a back
  patch and a helmet patch, so a player's team shows from every side and from first-person range.

## Files

| Path | What it is |
| --- | --- |
| `scripts/blender/generate_operator.py` | Builds the model in Blender from `art/source/scout.blend`, authors the new clips, bakes the atlas, exports, renders previews |
| `scripts/blender/finish_operator.mjs` | Compresses the atlas to KTX2 and writes the game model |
| `scripts/blender/validate_operator.mjs` | Checks the game model against the contract below and samples every clip |
| `public/models/operator-v1.glb` | The game model (`ARENA_ASSETS.character`) |
| `public/models/operator-motion-NOTICE.txt` | Public credit and terms for the CMU-derived walk and run |
| `art/source/operator.blend` | Editable Blender source (procedural materials, before baking) |
| `art/source/operator-*.png`, `operator-*.jpg` | Review renders |
| `art/source/operator-manifest.json` | Generator report: counts, clips, socket, pose audit, bake settings |
| `art/source/operator-v1-manifest.json` | Finish report: size, SHA-256, texture sizes |
| `art/source/operator-export-review.json` | Validator report |

## Rebuild

From the repository root (Blender 5.2 and KTX-Software; see `scripts/blender/run_blender.mjs` and
`KTX_BIN`):

```sh
node scripts/blender/run_blender.mjs --python scripts/blender/generate_operator.py
node scripts/blender/finish_operator.mjs
node scripts/blender/validate_operator.mjs
```

The generator takes about two minutes on the desktop CPU. It writes the baked atlas PNGs and the
raw GLB to `<system temp>/kannon-operator` (`--work` changes that), and the editable source,
previews and manifest to `art/source`. Useful options: `--stage preview` renders the unbaked look in
seconds; `--size`, `--bake-samples`, `--ao-samples` and `--render-samples` trade quality for time.
The finish step defaults to the same temporary folder (`--in`, `--out`, `--normal uastc|etc1s`).

## Runtime contract (for the client)

- **Skeleton.** `ScoutRig` with the 18 scout bones, names unchanged: `root, pelvis, spine, chest,
  neck, head, upper_arm_l, forearm_l, hand_l, upper_arm_r, forearm_r, hand_r, thigh_l, shin_l,
  foot_l, thigh_r, shin_r, foot_r`. The rest pose and inverse bind matrices equal the scout's
  (checked to 1e-5).
- **Mesh.** One skinned mesh, `scout_body`, with three materials: `ScoutSurface` (the gear atlas),
  `PlayerAccent` and `Visor` (the glasses lens). The names are kept from the scout so
  `CharacterImpact` and `BlenderCharacter` keep working. Boot soles are weighted 100% to the foot
  bones, which `LegContact` needs. No weapon meshes, no muzzles, no `healing_item`.
- **Team colour.** Set the colour of the cloned `PlayerAccent` material, as `BlenderCharacter` does
  now. It is a plain colour with no texture.
- **Clips.** `Idle, Walk, Run, Jump, Aim, Fire, Reload` have exactly the scout's samples. `Heal` is
  gone. `Fire` and `Reload` still start from Idle's upper-body pose, so the existing additive
  playback works.
- **New clips.** All are full-body base poses, in place, holding the weapon level at chest height.
  - `Crouch`: a two-second breathing loop of a low kneel, left foot forward, right knee down.
  - `CrouchWalk`: a 16/30-second loop at a **2.6 m/s reference**. Play it at
    `speed / 2.6` (negative for backwards), like Walk (6.5) and Run (9). Exported at 120 Hz.
  - `Slide`: a one-second held pose, feet first and reclined, with a small shudder. Loop it while
    the player slides.
  - Heads stay over the player's position and inside the shared hitboxes (`shared/physics.ts`):
    Crouch head centre about 1.17 m, CrouchWalk 1.19 to 1.21 m, Slide about 0.89 m.
- **Weapon socket.** An empty `weapon_socket` under `hand_r` marks the right palm on the pistol
  grip. At rest it sits at (0.14, 1.39, -0.336) m with no rotation, so its axes match the weapon
  models: -Z along the barrel, +Y up. To hold a gun, add the weapon root to the socket and move it
  by minus its `grip_r` position. It follows `hand_r` through every clip, including recoil and
  reloads. The left hand is posed for a rifle fore-end about 20 cm ahead of the right hand; a pistol
  will need its own support-hand placement.
- **Textures.** KTX2 (`KHR_texture_basisu`), so the loader needs `setKTX2Loader` as now. No meshopt
  or Draco. The root `extras.kannon` repeats the reference speeds and the socket convention.

## Checks

`node scripts/blender/validate_operator.mjs` checks the container, names, the clip list, the socket
position and axes, budgets (4 MB, 25,000 triangles, at most four material draws) and embedded KTX2
textures. It proves the rig and the seven kept clips match `public/models/scout.glb`, then plays
every clip through Three's AnimationMixer on the CPU and samples the real skinned vertices: boots
never go below the floor, Walk, Run and CrouchWalk loop without seams and with limited foot slip,
held feet do not slide, and the crouch and slide heads sit in their hitboxes. It writes
`art/source/operator-export-review.json`.

`scripts/blender/validate_glb.mjs` does not apply to this model: it requires the scout's weapons and
Heal clip, which the operator contract removes. (Its locomotion step also always reads
`public/models/scout.glb`, whatever `--glb` says.)

## Measurements

From `art/source/operator-export-review.json` for this build.

| Measurement | Operator v1 | Budget or scout v2 for comparison |
| --- | --- | --- |
| File size | 2,859,948 bytes (2.86 MB) | budget 4 MB; scout v2 2.14 MB |
| Triangles / exported vertices | 23,188 / 21,132 | budget 25,000 triangles; scout v2 20,114 with weapons |
| Material draws per player | 3 | scout v2: 4 body + 3 rifle |
| Gear atlas | colour 2048² ETC1S 479 kB, normal 1024² UASTC 770 kB, metal/roughness 1024² ETC1S 136 kB | |
| Kept clips vs scout | all 7 clips, 54 channels each, identical samples (difference 0) | |
| Rest pose / inverse binds vs scout | 7e-7 / 0 | 1e-5 |
| Weapon socket at rest | (0.140, 1.390, -0.336) m, rotation error 2e-7 rad | |
| Lowest boot point, Walk / Run / CrouchWalk | 6.8 / 6.5 / 6.3 mm above the floor | must stay above -1 mm |
| Foot slip p95 in the 20 mm band, Walk / Run / CrouchWalk | 0.19 / 0.64 / 0.09 m/s | limits 0.6 / 1.0 / 0.35 |
| Loop velocity seam, Walk / Run / CrouchWalk | 0.99 / 1.58 / 0.49 m/s | limits 1.3 / 1.8 / 1.0 |
| Head centre, Crouch / CrouchWalk / Slide | 1.17 / 1.19-1.21 / 0.89-0.90 m | hitboxes 0.95-1.25 / 0.95-1.25 / 0.72-1.0 |
| Silhouette top, Crouch / CrouchWalk / Slide | 1.33 / 1.37 / 1.06 m | |

Walk and Run keep the scout's motion exactly; their slip figures differ from the scout's own
report only because the operator's boot soles have different vertices to sample.

## Limits

- Skinning is mostly rigid with blended joints at the hips, knees, shoulders and elbows. Very deep
  bends pinch the trousers a little; the knee pads hide most of it.
- Ambient occlusion is baked on the rest pose, with arms raised for a rifle. It is short range (8 cm)
  so it darkens seams and pouch edges rather than casting arm shadows.
- The model's hands still close around the scout rifle's grip and fore-end. Weapons from
  `weapons-v1.glb` whose grips sit elsewhere will need the client to adjust the left hand.
- The slide is one held pose, not a full enter-and-exit animation; the client blends into it.
- These checks prove the asset, not how it looks in the browser at game distance or how it
  performs on a phone. Both need checking once the client loads it.

## Credits

The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with
funding from NSF EIA-0196217.

The Walk and Run lower-body motion derives from CMU subject 09, trial 01, frames 15 to 103,
retargeted to the scout skeleton (see [motion/cmu-09](../art/source/motion/cmu-09/CMU-USAGE-NOTICE.md)).
It is modified capture data, not CC0. It may be used in this game but must not be sold as motion
data or a converted animation pack. The public notice ships beside the model as
`public/models/operator-motion-NOTICE.txt`, and the GLB's `asset.copyright` carries the same credit.
The scout's own notice, `public/models/scout-motion-NOTICE.txt`, is unchanged.
