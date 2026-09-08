# Delivery and acceptance

## Live combat feedback release

Combat implementation [`5fc2c94`](https://github.com/Seckcey/kannon-fps/commit/5fc2c9472df97ffb81658a6d949b27bb60484f2a), merged through [PR #5](https://github.com/Seckcey/kannon-fps/pull/5), is deployed on Coastline at [kpop.8westventures.com](https://kpop.8westventures.com). [/health](https://kpop.8westventures.com/health) identifies the running build including documentation closeouts. The origin remains HTTP `127.0.0.1:14350`. The release improves per-pellet contacts, shield/armor feedback and respawn presentation while preserving the approved game, rules and V3 Blender models.

The combat release passed 108 tests, asset/type/build checks and [main CI](https://github.com/Seckcey/kannon-fps/actions/runs/34217145510). Ten desktop/touch input groups, eleven controlled renderer lifecycle checks, an eight-character hardware stress comparison and isolated eight-player Linux traffic provide separate evidence. Deployment verified the exact revision, healthy status, zero restarts, HTTP/WebSocket/public HTTPS/WSS responses, matching models and preserved data. Public rendered practice passed. See the [release record](RELEASE.md) for results and limits; earlier art/controller acceptance remains tied to the historical V3 release.

## Previous V2 visual and practice foundation

The previous V2 release, introduced through [PR #3](https://github.com/Seckcey/kannon-fps/pull/3) as implementation `bd58bd3`, added three active practice rivals with Relaxed, Balanced and Challenging difficulty. The entry flow remains **Practice first → choose difficulty → Create practice → Enter practice**. Bots use the existing loadout/combat/respawn rules, can win or draw, and keep difficulty across rematches. They follow ground routes around cover and platforms; jumping and climbing remain outside this slice. Practice never writes bot profiles or ranked results.

Room entry prepares retained GLB bytes before admission, then reuses those bytes for rendering. Failed downloads can retry without refetching successful assets. Replacing the player or leaving cancels stale entry work, so a delayed download cannot enter a room as a previous identity.

V2's focused checks covered AI perception, navigation and corner recovery, reaction/aim differences, weapons/healing, match outcomes, rematches, disconnect suspension, invalid settings, persistent-data isolation, asset sharing, timeout/retry and damaged GLB responses. A seeded match simulation checked movement/collider safety and bounded server work. Its rendered acceptance passed all nine groups without app errors; its isolated Linux candidate passed a real 60-second eight-player combat/reconnect test and all three practice difficulties. This remains historical V2 evidence. Neither it nor V3's checks establish physical-phone frame rates, wide-area performance or capacity for multiple simultaneous rooms.

## Deployed V3 art and motion

V3 improves exterior composition, foliage, architectural detail and the scout's posture without changing collision or match rules. Walk/Run lower-body motion derives from the selected CMU capture; the model, rig, weapon poses and six other actions remain original. Source provenance, a public credit notice and separate motion-data terms are included; `.gitattributes` preserves the exact publisher bytes. The motion is not CC0 or a directly resellable animation pack.

The animation controller uses measured playback rates, world-up leg turns, matching gait phase/rate and interruptible pose weights. A grounded two-bone leg constraint handles transition penetration. Replaying a completed Jump retains its outgoing pose in one reusable donor while a fresh one-shot begins. Validate source/exported geometry, complete controller transitions and actual rendered input separately; a positive source-frame clearance alone does not prove blending is correct.

[ART_DEPTH.md](ART_DEPTH.md) records V3's completed art/controller checks and remaining limits. Its implementation/CI identity, deployment and origin/public verification belong to the release record, separately from V2's evidence.

## Internet release gates

The completed gates below apply to the deployed combat release. Physical-device and family playtests remain open.

1. **Complete:** user approved Coastline; dedicated container, persistent SQLite volume, restart policy, resource limits, and loopback origin `127.0.0.1:14350` are running. The pre-release online SQLite backup passed integrity checks, and existing profiles, crews, memberships, and results were preserved. Backup/recovery procedures are documented; recurring off-host backups are not configured.
2. **Complete implementation and origin checks:** all 108 tests, asset/type/build checks, local input and isolated Linux acceptance passed. Implementation `5fc2c947` was verified at the origin with the exact merged revision, healthy status, zero restarts and passing HTTP/WebSocket smoke checks. `/health` remains authoritative for the running build. See the release record for each test's scope.
3. **Complete public entry points and rendered practice:** `kpop.8westventures.com` routes through the existing Cloudflare Tunnel to HTTP `127.0.0.1:14350`. Public HTTPS, the exact client bundle, secure WebSocket transport and both model hashes passed. [Live Balanced practice](verification/combat-feedback-live.json) verified release `5fc2c947`, three moving/firing rivals, valid received combat metadata, one download per matching V3 model and explicit exit without application errors. Verify actual devices and separate household connections below.
4. **Pending real devices:** test actual iPhone/Safari, Android/Chrome, and intended desktops. Record frame rates and controls; tune touch ergonomics with the players.
5. **Pending family playtest:** use the [family playtest guide](FAMILY_PLAYTEST.md) from two separate internet connections, including brief disconnection/recovery. Two tabs and emulated mobile sizes cannot prove this gate.

## After the first playtest

The live mobile/recovery behavior handles interrupted touch gestures, stale controls after backgrounding, unwanted graphics downgrades on resume, stalled connection retries, host recovery, finished-result replay, and simultaneous-hit fairness. These changes do not establish physical-phone or wide-area play acceptance; hit testing still has no rewind/lag compensation.

Tune weapon balance, healing, spawns, phone aim assistance, and map routes using observed gameplay. Improve animation/environment detail within the mobile budget. Add content after the core game loop is enjoyable and reliable.
