# Grounded Scout movement

This release refines the existing Blender character's Walk and Run clips. Feet slide less through their near-ground phases, the repeating stride has a smaller velocity discontinuity, and unstable knee direction near a straight captured leg is corrected. The model remains stylized. This is a bounded animation improvement, not Fortnite parity or a launch-quality claim.

The source checkout contains the checked candidate. Deployment and the exact running revision are recorded in [Release verification](RELEASE.md) and [/health](https://kpop.8westventures.com/health).

## Implementation

The new offline [Blender pass](../scripts/blender/scout_grounded.py) runs after CMU retargeting and speed retiming. Baseline support phases stay fixed while a rolling sole point guides the ankle trajectory. The target accounts for the actor's unchanged 6.5/9 m/s reference travel. A 4 cm animated pelvis adjustment gives the legs more bend, with a 5 mm extension reserve; neither actor movement nor rig proportions change. One bounded correction scale spans both support and the return during flight, preventing a reach failure from pulling the foot back abruptly.

A short Hermite segment repairs the loop boundary. Captured knee planes are filtered only where the source leg is nearly straight and its direction is unreliable. Reliable bends retain the captured direction. This removes the measured right-knee spike that appeared when greater stance flexion amplified a small, noisy source bend. Foot orientation and intended ankle height remain preserved by the fixed-length solve. Source generation records errors and any reach fallback; detailed frame diagnostics are available with `KANNON_GAIT_DIAGNOSTICS=1`.

The final GLB is **2,679,764 bytes**, SHA-256 `9b668768f6b47569f31a8f32c606a9a79e465c16cdcbe55b1e1d3ffa9e0108c9`, served at `/models/scout.glb?v=scout-grounded-v1`. It retains 21,658 vertices, 20,114 triangles, 18 bones, four body batches and three active AR batches. Full regeneration preserves positions, normals, skin, rig, material images and the six non-locomotion clips exactly. Equivalent oriented triangles have different index ordering; 42 UV components differ by at most 5.96e-8. Complete geometry buffers are therefore not byte-identical. The environment, gameplay, server, shared simulation, runtime animation controller and dependencies are unchanged.

## Checks and measured limits

[Local checks](verification/scout-grounded-source.json) passed all 133 tests, asset checks, TypeScript and the production build. The normal asset validator now rejects excessive loop velocity change, sliding and loss of near-floor coverage. It samples the actual final clip timestamp so timing tolerance cannot conceal the last pose. Independent negative fixtures reject the previous sliding asset and a corrupted terminal pose.

The actual exported skin is sampled at 480 Hz. These bands are near-floor proxies, not proof that every tracked point is physically planted. The following comparison uses the same standard validator method; historical baseline values were retained before the refinement.

| Measurement | Previous Walk → current | Previous Run → current |
| --- | --- | --- |
| 20 mm band, p95 horizontal slip | 1.750 → 0.105 m/s | 2.715 → 0.622 m/s |
| 40 mm band, p95 horizontal slip | 2.743 → 0.441 m/s | 5.978 → 1.580 m/s |
| Loop velocity discontinuity | 2.542 → 0.952 m/s | 3.287 → 1.534 m/s |
| 20 mm band coverage | 31.3% → 32.4% | 25.9% → 28.6% |

Minimum boot clearance remains about 6.54/6.46 mm, with bounded flight and exact authored position closure. The independent [comparison](verification/scout-grounded-comparison.json) passes all 64 correctness checks and 116 of 120 proposed improvement checks. It tracks the same baseline-selected stance windows and material points, forward and backward at multiple speeds. Four reverse-stance witness-drift limits remain exceeded: one Walk window repeats at three speeds and one Run window at sprint speed. Maximum drift increases from 10.09 to 14.38 mm for Walk and 6.94 to 13.45 mm for Run. Total travelled path decreases, but net drift also increases; these observations do not cancel the failed limits.

At maximum drift, those selected material points are 21.22/29.10 mm above the floor while the foot minima are 9.54/12.85 mm. That is compatible with heel/toe roll, not proof of perfectly natural contact. The release retains this bounded tradeoff given the broad slip reduction, corrected knee spike and controller/renderer evidence below. No proposed limit was reduced to claim an automatic pass. Finite-difference knee acceleration remains higher in some phases. The 4 cm animated pelvis adjustment also lowers the upper body in world space; unchanged upper local tracks do not mean unchanged world position. There is no zero-drift, seamless-joint-velocity or biomechanical-validity claim.

[Actual controller checks](verification/scout-grounded-controller.json) cover 16 cases and 2,268 samples, including every initial fade, strafe/reverse, slow movement, both reloads, healing, firing and rapid interruptions. Final model hashes matched, there were no application errors, sampled feet stayed above the floor and expected grips stayed under 1 cm. The first final fixture attempt lost its execution context during initial import while validation ran concurrently; the isolated repeat passed. That failed attempt is retained separately and its navigation cause was not established.

[Moving renderer review](verification/scout-grounded-visual.json) shows the actual GameView character travelling over the fixed arena floor through walking, sprinting, reverse and aim scenes, with no application errors. [Walk](art/scout-grounded-walk.png), [run](art/scout-grounded-run.png), [reverse](art/scout-grounded-reverse.png) and [aim](art/scout-grounded-aim.png) captures were inspected. Stills alone do not prove smooth motion; the measured skin and controller checks provide separate evidence. Known sky precision warnings are retained. These controlled desktop fixtures do not establish physical-phone performance, real input ergonomics or a two-household match. The [family playtest](FAMILY_PLAYTEST.md) remains necessary.

CMU source provenance and [separate motion terms](../art/source/motion/cmu-09/CMU-USAGE-NOTICE.md) remain intact. This motion is not CC0.
