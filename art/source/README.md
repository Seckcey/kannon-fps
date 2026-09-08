# Original Kannon Scout

`scout.blend` is the editable Blender 5.2 source for the character in
`public/models/scout.glb`. Geometry, surfaces, armature, weapon upper-body poses,
and six actions were authored for Kannon Arena. Walk and Run lower-body motion
derive from the CMU Graphics Lab's selected `09_01` running capture. Its source
and separate data terms are retained in [motion/cmu-09](motion/cmu-09/CMU-USAGE-NOTICE.md).

The Sunbreak scout has anatomically proportioned limbs, shaped charcoal undersuit,
contoured ivory ceramic plates, a reflective enclosed helmet, a fixed petrol-teal service pack,
restrained bronze fittings, gloves and boots, and modeled assault rifle, shotgun,
and healing item. The support hand reaches the weapon fore-end; reload and heal
reaches are solved in Blender and baked into the existing skeleton. The model is
original stylized game art with human proportions, not a scanned human.

## Rebuild and inspect

From the repository root:

```sh
blender --background --python scripts/blender/generate_scout.py
blender --background --python scripts/blender/validate_scout.py
node scripts/blender/validate_glb.mjs
```

The generator saves the Blender source, exports the game asset, and renders front
and back studio views in the actual Idle pose. The Blender validation checks skin
weights, boot clearance across every Walk and Run frame, supporting-hand contact
through Idle/Aim/Walk/Run/Fire, and the bent-knee staggered ready stance. It renders
Run/Reload/Heal frames, a geometry-based eight-pose contact sheet, and a studio
view matched to the gameplay shoulder camera. The binary glTF validation checks
attachment names, animations, geometry/material budgets, the packed PBR atlas and
its UV channel, weapon grips, both muzzles' world positions, and matching neutral
first frames for the three upper-body additive actions. The locomotion validator
loads the actual GLB through Three's AnimationMixer and samples its skinned sole
vertices at 480 Hz, including between exported keyframes. It reports floor
clearance, horizontal slip, contact duty and loop position/velocity seams. It runs
automatically after the structural checks in `validate_glb.mjs` and can also be
invoked separately with `node scripts/blender/validate_locomotion.mjs`.

Set `KANNON_GAIT_DIAGNOSTICS=1` in the generation environment to include detailed
240 Hz requested/solved ankle positions and knee-plane data in the source report.
Default reports stay compact while retaining solve-error maxima, reach counts,
knee-height minima and local rotation-step bounds. This flag changes reporting,
not the generated poses.

## Runtime contract

- Metres, feet at ground level, approximately 1.84 metres tall including the helmet.
- Exported axes: Y up, forward -Z. Blender source uses Z up and forward +Y.
- One 18-bone skeleton named `ScoutRig`; torso has blended skin weights; armor is
  weighted to its corresponding body segment.
- Named clips: `Idle`, `Walk`, `Run`, `Jump`, `Aim`, `Fire`, `Reload`, `Heal`.
- Walk and Run are in place; the game moves the root. Their reference speeds are
  **6.5 m/s** and **9 m/s**, with exact exported durations **16/30 seconds** and
  **14/30 seconds**. Playback is actual velocity divided by the reference speed,
  including 4 m/s aimed movement and slower analog input. Backward movement reverses
  the gait. The lower body turns toward lateral travel around world-up while the
  spine retains its animated world orientation and weapon grips.
  Jump's world height and grounded state come from game physics.
- Direction selection uses a dead band to avoid reversing the gait from small
  joystick fluctuations. Walk/Run transitions match both cycle phase and phase
  rate throughout the 160 ms blend, including changes to aimed movement speed.
- `CharacterBlend` preserves the current weights of every contributing base action
  when another transition interrupts the fade. Already active poses keep their
  animation time; they do not restart or jump back to full weight. Additive weapon
  actions remain independent of these base-pose weights.
- During grounded pose blends, `LegContact.ts` checks cached rigid boot vertices
  against the actor's support plane and solves the two leg joints for a clear
  ankle target. Foot world orientation and limb lengths are preserved. It does
  not translate the actor, pelvis or upper body, or change limb scale; procedural
  rotations are restored before each new animation evaluation. It applies only
  during the blend window, not as a general terrain or foot-locking system.
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

## Athletic pose pass

The rifle and both rest grips are 125 mm higher. Baked two-bone solves keep the
trigger hand, support hand, and weapon connected while the torso turns into a
three-quarter stance. Idle uses a 35 cm foot separation, 16 cm stagger and roughly
36-degree knee flex; Aim loads the stance slightly further. The shoulders and
helmet have flatter integrated fittings, the collar has a fabric silhouette,
and swept armor plates follow the limbs. The fixed teal pack remains distinct
from the narrow player-color identifiers.

Idle breathes without dragging either planted foot. Walk and Run preserve both
weapon grips, Fire moves the weapon and supporting hand together, Reload reaches
the magazine and belt, and Heal lowers the case for a two-handed use pose. Weapon
actions are authored animation, not a full weapon simulation.

The preceding V3 export used 22,486 vertices, 20,922 triangles and a 2,720,096-byte GLB,
retaining all 18 bones and eight clips. The export still uses four body draws and three
AR draws, or 56 character draws for eight visible AR scouts, excluding shadow passes.
Its SHA-256 is `7e0b589e779c403dbbe61a5522fcbc4503de99815a6782b18b355cbecfe1091e`.

The preceding shoulder-polish export fitted tapered ceramic plates to the upper arms
and joins the cloth shoulders into the upper back. It has 21,658 vertices,
20,114 triangles and a 2,672,192-byte GLB, with SHA-256
`077be3e5789c136e1607e11cf7d9a243ee4324c44bc92877a3522d706e57bfd0`.
That geometry-only release preserved all 18 rest bones, inverse binds, both muzzles
and 432 animation channels; the four body and three AR draws remained unchanged. The paired neutral,
Aim, Run, Fire, Reload and Heal source previews and structural comparisons are
recorded in `scout-shoulder-pose-review.json` and `scout-shoulder-export-review.json`.
See [motion-polish acceptance](../../docs/SCOUT_MOTION_POLISH.md) for that release's
separate rendered checks. It did not repair contact slip or loop velocity seams.

The current grounded-gait source preserves that authored geometry and rig while
refining Walk/Run pelvis and legs. It has 21,658 exported vertices, 20,114 triangles
and a 2,679,764-byte GLB, SHA-256
`9b668768f6b47569f31a8f32c606a9a79e465c16cdcbe55b1e1d3ffa9e0108c9`,
at `/models/scout.glb?v=scout-grounded-v1`. The six nonlocomotion clips match the
preceding export's Float32 tracks exactly; the four body and three AR draws remain
unchanged. The [release record](../../docs/RELEASE.md) identifies deployed artifacts
separately from this checkout.

Full regeneration preserves position, normal, skin, rig and embedded-image data.
The torso index representation changes but contains the same oriented triangles,
with no added, removed or reversed faces. Forty-two UV components differ by at
most 5.960464×10⁻⁸ from the preceding representation. This is equivalent authored
geometry with tiny UV rounding, not a claim that every geometry buffer is byte-identical.

`scout-gameplay-pose.png` is a Blender studio render using the game's shoulder
camera framing; it is not a browser capture. The existing `scout-runtime-front.png`,
`scout-runtime-back.png`, and `scout-runtime-eight.png` images belong to the prior
Sunbreak pass. These source previews are separate from the controller validation
below and from real-input gameplay or performance testing. No claim of matching
the concept art or a physical phone frame rate follows from these asset checks.

## Captured lower-body locomotion

`scripts/blender/cmu_asf.py` strictly parses the retained ASF/AMC files and evaluates
their skeletal transforms. `scout_locomotion.py` verifies the source digests,
selects source frames 15–103 at 120 Hz, removes horizontal root travel/yaw,
retargets pelvis and legs to the scout, and preserves the original weapon-ready
upper-body poses. Only `Walk` and `Run` change. The original authored gait actions
remain in the editable blend as `Original_Walk`/`Original_Run`, outside exported NLA tracks.

The selected source travels 2.6602 metres in 0.7333 seconds. After the target leg
scale of 0.9353, uniform speed matching would require approximately 5.22/7.23
steps per second at game speeds. The baked timing instead compresses measured
support travel and allocates remaining time to flight/swing, giving 3.75/4.29
steps per second. This is an adaptation of captured movement, not untouched mocap.

`scout_grounded.py` then works in final clip time at 240 Hz. Its circular support
masks and per-interval sole-point labels come from the uncorrected retimed poses.
It integrates horizontal ankle travel to account for the same material point's
foot rotation and forward motion, rather than pinning one forefoot vertex through
the whole roll. A 4 cm constant animated pelvis drop supplies natural knee flexion;
actor/root position, collision, movement speeds and rig rest geometry are unchanged.
Two-bone solves preserve foot orientation and the post-seam height profile, with
6 mm minimum clearance and a 5 mm extension reserve. The whole support/flight
trajectory shares its reach scale and an 8 cm correction bound. A 30 ms Hermite
return matches correction value and velocity during flight. A nearest-sphere
fallback is counted and measured; the current source report records zero uses.

The original distributed source endpoint correction is position-only. A separate
Hermite repair spans 16.667 ms on each side of the final-time boundary. Captured
knee planes near extension are stabilized with a circular temporal filter weighted
by original bend height squared; confidence smoothly returns to the original plane
between 20 and 60 mm knee bend. The plane/confidence boundaries receive the same
short repair. Reliable captured motion, upper-body local curves and all six other
actions remain outside that correction. The source report exposes measured errors
instead of treating the intended foot-height target as an unconditional guarantee.

`scout_export.py` bakes a temporary 120 Hz pass and replaces only Walk/Run sampler
buffers in the ordinary 30 Hz export. It removes their frame-one time offset, so
the exported loop duration matches the reference. Geometry and the six other clips
retain their base export data. The migration check compared every Float32 track
in those six clips against the prior scout export and found exact equality.
Both bake stages remain in temporary files; only a successful complete merge
atomically replaces the public GLB. A failed dense bake preserves the prior asset.

The current [480 Hz exported-skin report](scout-locomotion-export-review.json)
covers 257 normal and 225 sprint poses. Lowest soles are +6.54/+6.46 mm without
changing actor world height. At 20 mm, horizontal-slip medians are 0.030/0.175 m/s,
95th percentiles are 0.105/0.622 m/s, and contact duty is 32.4%/28.6%. At 40 mm,
medians are 0.033/0.176 m/s, 95th percentiles are 0.441/1.580 m/s, and duty is
53.5%/45.5%. Contact statistics exclude penetrating samples and do not imply
perfect forefoot locking.

Sampled loop positions coincide, while endpoint velocity differences remain
0.95/1.53 m/s, down from the preceding 2.54/3.29 m/s. The final resampled motion
is not velocity-seamless. Small reverse foot-roll drift and acceleration remain
limitations; fixed-baseline witnesses and rendered judgment are separate from the
conditional contact medians. Asset-only sampling does not prove crossfade contact.
The final-model controller check below measures those transitions separately.

## Runtime transition validation

The [final-model controller check](../../docs/verification/scout-grounded-controller.json)
passed 16 cases and 2,268 deterministic samples at 120 Hz through the actual
`createBlenderCharacter` used by GameView. It included every initial 160 ms fade,
lateral/reverse/slow travel, moving reload/heal/fire and repeated stop/start/aim/sprint
changes every 50 ms. Requested, loaded and final asset hashes matched `9b668768...`.
The minimum sole clearance was +5.9999 mm and expected support-hand gaps stayed
below 8.89 mm, with no application errors. The known sky shader precision warning
is recorded separately. These measurements establish the tested transition
constraints, not perfect horizontal locking, seamless joint velocity, physical-phone
performance or multiplayer acceptance. Actual input, camera readability, device
performance and the family playtest remain separate.

The data used in this project was obtained from mocap.cs.cmu.edu. The database
was created with funding from NSF EIA-0196217. See the retained notice before
redistributing source or derived motion; these motions are not CC0 and must not
be sold directly as motion data or a converted animation pack.
The same credit and terms ship publicly in
[`public/models/scout-motion-NOTICE.txt`](../../public/models/scout-motion-NOTICE.txt).
