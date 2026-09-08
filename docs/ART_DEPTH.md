# Sunbreak art depth and motion

This development pass builds on the shipped Sunbreak environment and active practice release. It improves composition and character presentation without changing the arena's collision footprint, accepted camera, loadout, movement speeds or match rules.

## Visible changes

Asymmetric exterior terraces frame the center of the arena. Closed service shutters distinguish the playable buildings from low tactical cover, while shallow frames and fitted metal corners add visible construction depth. Taller scenery remains outside the playable boundary. Connected mature tree crowns replace scattered branch clumps; six rooted perimeter planters replace isolated leaf fragments. Teal metal uses restrained nondirectional wear, and shallow facade surfaces avoid coplanar overlap.

The scout raises its rifle, turns the torso and adopts a staggered bent-knee stance. Helmet, collar, shoulders and leg shells have more continuous silhouettes. Original weapon grips and Fire/Reload/Heal actions remain authored in Blender. The export preserves the existing 18 bones, eight clips and four body/three AR material draws.

The HDR sky background is exposed separately at 0.28 so its blue and cloud shapes survive tone mapping; its scene lighting stays unchanged. The conventional color-target fallback keeps its previous 0.8 background intensity. Both model URLs advance to `sunbreak-v3` so a new page cannot reuse the previous release's cached bytes.

## Verification and remaining work

Source viewpoint captures cover the south platform, both approaches, all eight spawns and a phone-sized crop. They are fixed-scene art comparisons, not multiplayer or phone performance proof. Automated checks, actual input and quality-mode evidence are separate release gates.

A controlled Low-quality comparison loads the old and new GLBs into the same renderer, camera, eight-player scene and fixed pixel budget. The corrected art measured 54 median FPS, between baseline runs of 56 and 57, with 79 draws throughout. This is a desktop GPU comparison, not phone performance or a network load test.

The first export measured 49 FPS in an isolated environment comparison, while the scout-only change matched the 57 FPS baseline. Review found a hidden slab top beneath the new paved surface, adding approximately 0.48 screen equivalents before depth testing. The corrected export removes that redundant shading and joins the slab sides to Y=0. The validator now requires exactly one 4,096 m² upward floor and checks its four boundary joins. Fuller tree crowns are retained: CPU projection found less leaf-card screen area than in the old scene, while the added architecture occupies more visible pixels. Constant draw count alone does not establish constant rendering cost.

The original hand-keyed lower-body gait slid at the authoritative 6.5 m/s normal and 9 m/s sprint speeds. Walk and Run now derive from the CMU Graphics Lab's selected `09_01` running capture, retargeted and timed in Blender. Geometry, rig, weapon poses and six other actions remain original; those six exported actions retain exactly the same Float32 tracks as the preceding scout. Source data and terms are retained with attribution. CMU permits use in games but prohibits direct resale as motion data; this source is not CC0. See [the source notice](../art/source/motion/cmu-09/CMU-USAGE-NOTICE.md) and the publicly served [motion notice](../public/models/scout-motion-NOTICE.txt).

The normal and sprint cycles last 16/30 and 14/30 seconds, with reference speeds matching 6.5 and 9 m/s. Playback slows proportionally for aimed and analog movement and reverses for backward travel. A direction dead band prevents joystick noise from repeatedly reversing the gait. Lower-body turns use world-up, preserving boot height while the upper spine retains its animated world orientation and weapon grips.

Walk/Run alone are exported at 120 Hz. The actual GLTFLoader/AnimationMixer skin validator samples them at 480 Hz, including between keys; 257 normal and 225 sprint poses stay at least +6.53/+6.31 mm above the floor. Conditional contact-slip medians at a 20 mm threshold are 0.51/0.92 m/s, with 31%/26% contact duty. Feet are not perfectly locked. Loop positions agree within one micrometre, but endpoint velocity differences remain; these loops are position-continuous, not derivative-continuous.

The actual game controller initially exposed a separate 74 mm boot dip during a 160 ms idle-to-movement blend. Walk/Run transitions now share both cycle phase and phase rate. During grounded blends, a two-bone leg constraint uses the rendered boot's bind-local geometry to lift an ankle target and rotate the thigh, shin and foot. It preserves bone lengths, foot orientation, the actor root, pelvis and upper body. Corrections are restored before each new mixer update and are inactive during steady motion and jumps.

A deterministic 120 Hz acceptance run through the actual character controller covers 16 scenarios and 2,268 frames, including every initial blend frame, normal/sprint/aim/slow touch speeds, both lateral directions, reverse travel, moving reloads/healing, fire and repeated 50 ms movement changes. The lowest tested sole is +6 mm, all sampled poses are finite, and expected weapon grips remain below 8.89 mm. The harness verifies actual limb and upper-action movement plus the loaded GLB hash; it is distinct from real input, network acceptance and frame-rate measurement. An occasional sky-bake shader precision warning remains recorded separately.

Interrupted movement fades retain the full current base-pose weight vector instead of restarting an outgoing action at full strength. An actual-controller CPU comparison found the first 8.33 ms of a quick stop/restart moved a limb 1.22/3.02 cm, down from 33.76/40.25 cm with the previous fade scheduling. Zero-time retargeting preserves the posed skeleton. Across the longer rendered 50 ms movement-change sequence, the largest sampled ankle step is 4.78 cm, below the regression check's 8 cm limit.

Architecture and the armored character remain stylized and simpler than the generated concept. Physical-phone controls/rendering and a two-household playtest remain unverified. The live implementation and exact deployment evidence are recorded separately in [RELEASE.md](RELEASE.md).
