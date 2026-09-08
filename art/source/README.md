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

The V3 export has 22,486 vertices, 20,922 triangles and a 2,720,096-byte GLB,
retaining all 18 bones and eight clips. The export still uses four body draws and three
AR draws, or 56 character draws for eight visible AR scouts, excluding shadow passes.
Its SHA-256 is `7e0b589e779c403dbbe61a5522fcbc4503de99815a6782b18b355cbecfe1091e`.

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

`scout_export.py` bakes a temporary 120 Hz pass and replaces only Walk/Run sampler
buffers in the ordinary 30 Hz export. It removes their frame-one time offset, so
the exported loop duration matches the reference. Geometry and the six other clips
retain their base export data. The migration check compared every Float32 track
in those six clips against the prior scout export and found exact equality.
Both bake stages remain in temporary files; only a successful complete merge
atomically replaces the public GLB. A failed dense bake preserves the prior asset.

The 480 Hz exported-skin check covers 257 normal and 225 sprint poses. Lowest
soles are +6.53/+6.31 mm, removing the previous roughly 6 mm interpolation dip
without changing actor world height. At a 20 mm contact threshold, horizontal
slip medians are 0.51/0.92 m/s; contact duty is 31%/26%. At 40 mm, medians are
0.66/0.96 m/s and duty is 54%/46%. Contact statistics exclude penetrating samples.
These conditional contact measurements do not mean the feet are perfectly locked.

Loop positions agree within 0.000001 metre. Endpoint velocity discontinuities
remain (maximum sampled sole-vertex difference 2.54/3.29 m/s); the distributed
endpoint correction makes the cycle position-continuous, not derivative-continuous.
The asset-only validator does not prove gameplay crossfade contact. A separate
actual-controller check now covers those first 160 ms, as described below.

## Runtime transition validation

The V3 browser controller check evaluated the actual `createBlenderCharacter`
used by GameView, with 16 cases and 2,268 deterministic samples at 120 Hz. It
included every initial fade sample: idle to normal, normal to sprint, sprint to
aim, lateral direction changes, backward and slow movement, moving AR/shotgun
reload, healing, returning to ready, fire and repeated stop/start/aim/sprint
changes every 50 ms. The loaded GLB hash matched the
artifact above. All sampled poses were finite, limb motion exceeded the numeric
regression's movement threshold, and no application errors occurred.

The lowest sampled sole was +5.9999 mm, including the transitions that previously
penetrated by roughly 7 cm. Measured support-hand gaps where a grip was expected
stayed below 8.89 mm. The report is recorded as `art-depth-motion-acceptance.json`
in the local QA evidence directory. Its known sky-bake shader precision warning
is recorded separately from application errors.

These are deterministic controller and skinned-geometry measurements in a browser,
not physical-phone or multiplayer acceptance. They establish the tested transition
constraints, not perfect horizontal foot locking, seamless joint velocity, natural
motion in every situation or parity with the illustrated concept. Actual input,
camera readability, device performance and the family playtest remain separate.

The data used in this project was obtained from mocap.cs.cmu.edu. The database
was created with funding from NSF EIA-0196217. See the retained notice before
redistributing source or derived motion; these motions are not CC0 and must not
be sold directly as motion data or a converted animation pack.
The same credit and terms ship publicly in
[`public/models/scout-motion-NOTICE.txt`](../../public/models/scout-motion-NOTICE.txt).
