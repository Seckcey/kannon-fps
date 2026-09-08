# Combat feedback

Status: deployed September 8, 2026 as implementation `5fc2c947`, through [PR #5](https://github.com/Seckcey/kannon-fps/pull/5). This slice improves the readability of accepted shots, shield damage and respawns. Candidate `40b5c829` supplied the verified implementation; later pre-merge changes added documentation only. See [RELEASE.md](RELEASE.md) for CI, deployment and the separate historical releases; public `/health` identifies the running build including documentation closeouts.

## Scope

Each AR ray and shotgun pellet now carries its authoritative endpoint and contact classification: world, player or range. Effects follow each pellet independently, so the existing aggregate “any pellet hit” flag cannot invent an impact at the center pellet's endpoint. Range endpoints produce no impact, and protected-player contacts produce no damage sparks. Optional shield/protection trace flags describe collision state before that tick's damage resolves; they are not damage awards. Older events without trace metadata retain conservative tracer feedback.

Damage events add the shield damage, health damage and shield-break result actually accepted by the server. These drive the struck character's shield, armor or break response and the shield-break sound. Damage remains aggregated per victim within a simulation tick; this work does not present that aggregate as an individual attacker's damage number. Opponent nameplates now pair the existing health bar with a shield bar.

Muzzle flares, tracers, contact sparks, stone dust/chips, elimination fragments and rising heal/respawn effects use fixed-capacity pools in two render batches. The visual muzzle is clipped against the existing map; tracers retain authoritative contacts and respect intervening cover. A point-blank contact behind an extended animated barrel keeps its impact without drawing a reverse beam. A delayed shot from a previously equipped weapon keeps its accepted trace/contact but does not flash or recoil the newly equipped weapon.

The actual skinned scout body uses one private PBR material copy per character. Its existing atlas modulates restrained cyan shield, warm armor and pale shield-break emission, preserving the dark undersuit and surface detail. Peak strengths are 0.20/0.14/0.34 with 180/150/290 ms decay. The atlas is bound before first render; hits change emission uniforms without changing shader defines. The loading fallback uses its already private accent material.

Respawn effects wait for a fresh authoritative living snapshot, then appear at the new position. A separate local respawn latch resets the camera when that life arrives, including after backgrounding. Hidden or stale combat presentation is discarded; visibility changes clear existing particles and pending respawn visuals instead of replaying them on return.

## Invariants

- Movement, aiming, camera geometry, collision, spread, hit resolution, damage amounts, cadence, protection, loadout, scoring and standings rules remain unchanged. New wire fields are optional presentation metadata.
- Body pulses do not move bones, the root, hands, weapons or the camera. Player accent colors, protection bubbles, shared cached materials, textures and UV transforms stay intact. Expiry, death, disconnect, respawn and disposal restore exact original emission; repeated hits replace a bounded pulse.
- Effects are depth-tested and bounded; they do not reveal occluded targets or allocate a new material/geometry for every shot. Cleanup releases owned resources and ignores late calls.
- Both shipped GLB hashes are unchanged from the deployed Sunbreak art-depth assets listed in [RELEASE.md](RELEASE.md).

## Verification and remaining acceptance

The [sanitized local evidence record](verification/combat-feedback-local.json) binds these checks to candidate `40b5c829` and separates CPU, hardware, real-input and synthetic-state evidence. Its preparation timestamp is later than the collected checks; private test identities, session data and local paths are omitted.

The full local `npm run check` passed **108 tests**: 79 prior regressions, 10 server metadata cases, six character-impact cases and 13 effects/respawn cases, plus asset/source validation, TypeScript and the production build. Actual-scout CPU checks cover material isolation, atlas identity, stable material versions, unchanged poses, absolute-time expiry and disposal. Effects checks cover pool bounds, pellet/contact routing, clipping, protected/range endpoints, point-blank behavior, weapon changes and deferred respawn lifecycle.

A baseline server comparison covered **80 scenarios, 7,200 simulation steps, 2,233 shots and 1,015 damage events**. Compared outputs were identical after stripping the added metadata. This is bounded evidence of unchanged outcomes for those scenarios.

Initial CUA actual-UI and controlled-renderer checks compiled and rendered without application or shader-program errors. They exposed excessive body-pulse brightness; atlas modulation and reduced strengths were applied for follow-up captures. CUA reports **Microsoft Basic Render Driver**, a software renderer, so those runs support no hardware FPS claim.

Eleven further CUA checks exercised the actual `GameView` using **synthetic snapshots/events**. Stale shots stayed quiet; a fresh shot produced 11 effect quads and one sound. Visibility cleared effects, and 26/50 rival shield displayed as 52%. Respawn presentation waited for the fresh living position, emitted once and reset the camera once; repeated snapshots did not replay it. Hidden events stayed quiet while preserving the local respawn latch, and return after an unseen life reset the camera without replaying a hidden burst. Disposal left zero players/effect meshes, detached the canvas and ignored late events, with no application or shader-program logs. Agent-created tabs and fixtures were removed while the existing user tab was preserved. This is lifecycle evidence, separate from authoritative-input or physical-phone acceptance.

The separate installed-Edge hardware comparison used **AMD Radeon (0x13C0)** at a fixed **1265×720**, pixel ratio 1, Low quality and eight animated players. Six AR actors fired every 150 ms and two shotgun actors every 900 ms, approximately 42 shots/second. All runs used the same viewport and pixel budget. Final ten FPS samples were:

| Run | FPS samples |
| --- | --- |
| Baseline | 49, 49, 49, 49, 50, 48, 50, 50, 50, 47 |
| Candidate | 50, 49, 51, 50, 51, 50, 51, 49, 49, 49 |
| Baseline repeat | 54, 51, 50, 54, 53, 54, 53, 53, 54, 50 |

The candidate's **49–51 FPS** falls within the bracketing baselines' **47–54 FPS** variation; this is not evidence of a speedup. Its separate final renderer-counter capture recorded 81 draws, 73 geometries and 24 textures, with at most two combat-effects batches. Application errors and shader-program logs were empty; one known sky warning was recorded. This controlled cosmetic stress fixture measures neither server capacity nor physical-phone performance. The final full check passed all 108 tests, asset validation, TypeScript and the production build.

The built client (`index-CMlsxsdw`) passed ten desktop/touch acceptance groups at 1536×1024, 852×393 and 390×844. Real keyboard, mouse and touch input exercised private room entry, both weapons, reloads, jumps, healing, crew standings, practice difficulties, explicit exit and rotation. Received events carried the exact one/nine trace counts and the accepted 2-shield/22-health break. No application errors occurred.

The exact implementation passed [isolated Linux acceptance](verification/combat-feedback-linux.json) with eight real clients for 60 seconds: 14,418 inputs, 1,296 AR shots and 160 shotgun shots, including safe ninth-player rejection and reconnect. Snapshots arrived at about 15.06 Hz; the worst gap was 69.53 ms, and the worst peer's p95 latest-input acknowledgment age was 34.29 ms. No unexpected transport errors occurred. New metadata added about 4.33 KB/sec per player in this run; the complete decoded JSON payload averaged 69.21 KB/sec, excluding transport headers. All three practice difficulties passed twelve-second observations with three moving/firing rivals and unchanged standings/history. The temporary container shared one CPU and 512 MiB with its load generator, had no external network or production data, and was removed afterward. Production and all 65 other containers were unchanged during that isolated test.

After deployment, [public rendered practice](verification/combat-feedback-live.json) verified exact revision `5fc2c947` through HTTPS/WSS, the final client bundle, all three rivals moving/firing, one matching download per model and explicit exit. Its short observation included 13 AR shots and six damage events with valid metadata; no shotgun shot occurred in that public sample. Both weapons remain covered by local real-input and Linux acceptance. Application errors were empty. The known sky warning and externally injected analytics script blocked by the existing CSP remain separately recorded. An initial harness assertion was corrected to distinguish that external script from the exact game module before rerunning; no game or CSP change was required. The [live image](art/combat-feedback-live.png) is actual deployed gameplay.

Physical-phone rendering, controls and aim balance, two-household play, and feedback from the family remain open. CPU invariants, bounded desktop rendering and the desktop real-input/lifecycle checks do not close those acceptance items. The [family playtest guide](FAMILY_PLAYTEST.md) describes the next check.
