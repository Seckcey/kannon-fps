# Delivery and acceptance

## Live scout form, movement and platform release

Source [`25f31ba`](https://github.com/Seckcey/kannon-fps/commit/25f31bada5062bf69ad8008c690e0a2a9f18ca71), merged through [PR #6](https://github.com/Seckcey/kannon-fps/pull/6) as [`bbc40d3`](https://github.com/Seckcey/kannon-fps/commit/bbc40d344e62250dd88d75d7208c6570d66dcf57), is deployed on Coastline at [kpop.8westventures.com](https://kpop.8westventures.com). [/health](https://kpop.8westventures.com/health) identifies the running build including documentation closeouts. The origin remains HTTP `127.0.0.1:14350`. The [release](SCOUT_MOTION_POLISH.md) integrates the scout's shoulders and upper back, aligns movement animation with visible travel, respects confirmed reload/heal sprint restrictions in prediction, and lets practice rivals use the existing south stairs/platform. All eight animation clips, rig and weapon handling remain unchanged, as do shared collision, movement rules, loadout and scoring.

All 133 tests, asset/type/build checks and [main CI](https://github.com/Seckcey/kannon-fps/actions/runs/34224016799) passed. Sixteen controlled actual-GameView cases, ten built desktop/touch input groups and isolated Linux acceptance provide separate evidence. The eight-moving-character A/B/A comparison recorded median FPS of 53/54/53 for baseline/candidate/baseline at the same fixed rendering budget. This supports no observed regression in that bounded comparison, not a speedup or physical-phone claim.

[Deployment checks](verification/scout-motion-deployment.json) verified the exact revision, runtime, data and protected services. [Public rendered practice](verification/scout-motion-live.json) passed on `bbc40d3` with bundle `index-jzcelI6T` and the new shoulder GLB: all three rivals moved and fired, with 21 AR shots, ten damage events and two shield breaks observed. No shotgun shots occurred in this short public sample; the separate built-input acceptance covered both weapons. There were no application errors; known sky and CSP warnings remain recorded. See the [release record](RELEASE.md) for exact results and limitations.

## Previous combat feedback foundation

Combat implementation `5fc2c94`, introduced through [PR #5](https://github.com/Seckcey/kannon-fps/pull/5), added per-pellet contacts, shield/armor reactions and fresh-position respawn effects while retaining the then-current V3 models. Its 108-test, renderer, input, Linux and public acceptance remains historical evidence in the [combat record](COMBAT_FEEDBACK.md); it is not the validation count or model identity of the current release.

## Previous V2 visual and practice foundation

The previous V2 release, introduced through [PR #3](https://github.com/Seckcey/kannon-fps/pull/3) as implementation `bd58bd3`, added three active practice rivals with Relaxed, Balanced and Challenging difficulty. The entry flow remains **Practice first → choose difficulty → Create practice → Enter practice**. Bots use the existing loadout/combat/respawn rules, can win or draw, and keep difficulty across rematches. V2 navigation followed ground routes around cover and platforms; the current release adds the existing stair route without jumping or general climbing. Practice never writes bot profiles or ranked results.

Room entry prepares retained GLB bytes before admission, then reuses those bytes for rendering. Failed downloads can retry without refetching successful assets. Replacing the player or leaving cancels stale entry work, so a delayed download cannot enter a room as a previous identity.

V2's focused checks covered AI perception, navigation and corner recovery, reaction/aim differences, weapons/healing, match outcomes, rematches, disconnect suspension, invalid settings, persistent-data isolation, asset sharing, timeout/retry and damaged GLB responses. A seeded match simulation checked movement/collider safety and bounded server work. Its rendered acceptance passed all nine groups without app errors; its isolated Linux candidate passed a real 60-second eight-player combat/reconnect test and all three practice difficulties. This remains historical V2 evidence. Neither it nor V3's checks establish physical-phone frame rates, wide-area performance or capacity for multiple simultaneous rooms.

## Previous V3 art and motion foundation

V3 improves exterior composition, foliage, architectural detail and the scout's posture without changing collision or match rules. Walk/Run lower-body motion derives from the selected CMU capture; the model, rig, weapon poses and six other actions remain original. Source provenance, a public credit notice and separate motion-data terms are included; `.gitattributes` preserves the exact publisher bytes. The motion is not CC0 or a directly resellable animation pack.

The animation controller uses measured playback rates, world-up leg turns, matching gait phase/rate and interruptible pose weights. A grounded two-bone leg constraint handles transition penetration. Replaying a completed Jump retains its outgoing pose in one reusable donor while a fresh one-shot begins. Validate source/exported geometry, complete controller transitions and actual rendered input separately; a positive source-frame clearance alone does not prove blending is correct.

[ART_DEPTH.md](ART_DEPTH.md) records V3's completed art/controller checks and remaining limits. Its implementation/CI identity, deployment and origin/public verification belong to the release record, separately from V2's evidence.

## Internet release gates

The completed gates below apply to the deployed scout form, movement and platform release. Physical-device and family playtests remain open.

1. **Complete:** user approved Coastline; dedicated container, persistent SQLite volume, restart policy, resource limits, and loopback origin `127.0.0.1:14350` are running. The pre-release online SQLite backup passed integrity checks, and existing profiles, crews, memberships, and results were preserved. Backup/recovery procedures are documented; recurring off-host backups are not configured.
2. **Complete implementation and origin checks:** all 133 tests, asset/type/build checks, controlled renderer cases, built input and isolated Linux acceptance passed. Exact merged release `bbc40d344e62250dd88d75d7208c6570d66dcf57` passed [deployment verification](verification/scout-motion-deployment.json). `/health` remains authoritative for the running build, including later documentation closeouts. See the release record for each test's scope.
3. **Complete public entry points and rendered practice:** `kpop.8westventures.com` routes through the existing Cloudflare Tunnel to HTTP `127.0.0.1:14350`. Public HTTPS/WSS and [live Balanced practice](verification/scout-motion-live.json) verified release `bbc40d3`, the matching new shoulder model and three moving/firing rivals without application errors. Known warnings are recorded separately. Verify actual devices and separate household connections below.
4. **Pending real devices:** test actual iPhone/Safari, Android/Chrome, and intended desktops. Record frame rates and controls; tune touch ergonomics with the players.
5. **Pending family playtest:** use the [family playtest guide](FAMILY_PLAYTEST.md) from two separate internet connections, including brief disconnection/recovery. Two tabs and emulated mobile sizes cannot prove this gate.

## After the first playtest

The live mobile/recovery behavior handles interrupted touch gestures, stale controls after backgrounding, unwanted graphics downgrades on resume, stalled connection retries, host recovery, finished-result replay, and simultaneous-hit fairness. These changes do not establish physical-phone or wide-area play acceptance; hit testing still has no rewind/lag compensation.

Tune weapon balance, healing, spawns, phone aim assistance, and map routes using observed gameplay. Improve animation/environment detail within the mobile budget. Add content after the core game loop is enjoyable and reliable.
