# Delivery and acceptance

## Live Sunbreak V3 release

Sunbreak V3 implementation release [`884e24d`](https://github.com/Seckcey/kannon-fps/commit/884e24d422e1666a5caccc90a642da7b58de594d), merged through [PR #4](https://github.com/Seckcey/kannon-fps/pull/4), is deployed on Coastline at [kpop.8westventures.com](https://kpop.8westventures.com). The [/health](https://kpop.8westventures.com/health) endpoint is the canonical current deployed build identity, including later documentation closeouts. The origin remains HTTP `127.0.0.1:14350`. V3 retains the approved third-person view, fixed loadout/healing, respawns/protection, server-owned multiplayer, private invitations/crews, persistent rankings/history, keyboard/mouse and touch interfaces, and active solo practice rivals, while adding the art and motion work below.

V3 passed 79 automated tests, TypeScript, asset validation and the production build, with [successful main CI](https://github.com/Seckcey/kannon-fps/actions/runs/34209569042). Source/exported-skin, actual-controller and real-input checks provide separate animation/gameplay evidence. Deployment verified the exact merged revision, healthy status with zero restarts, HTTP/WebSocket/public HTTPS/WSS responses and matching model hashes; existing profile and crew data were preserved. See the [release record](RELEASE.md) for exact results and limitations.

## Previous V2 visual and practice foundation

The previous V2 release, introduced through [PR #3](https://github.com/Seckcey/kannon-fps/pull/3) as implementation `bd58bd3`, added three active practice rivals with Relaxed, Balanced and Challenging difficulty. The entry flow remains **Practice first → choose difficulty → Create practice → Enter practice**. Bots use the existing loadout/combat/respawn rules, can win or draw, and keep difficulty across rematches. They follow ground routes around cover and platforms; jumping and climbing remain outside this slice. Practice never writes bot profiles or ranked results.

Room entry prepares retained GLB bytes before admission, then reuses those bytes for rendering. Failed downloads can retry without refetching successful assets. Replacing the player or leaving cancels stale entry work, so a delayed download cannot enter a room as a previous identity.

V2's focused checks covered AI perception, navigation and corner recovery, reaction/aim differences, weapons/healing, match outcomes, rematches, disconnect suspension, invalid settings, persistent-data isolation, asset sharing, timeout/retry and damaged GLB responses. A seeded match simulation checked movement/collider safety and bounded server work. Its rendered acceptance passed all nine groups without app errors; its isolated Linux candidate passed a real 60-second eight-player combat/reconnect test and all three practice difficulties. This remains historical V2 evidence. Neither it nor V3's checks establish physical-phone frame rates, wide-area performance or capacity for multiple simultaneous rooms.

## Deployed V3 art and motion

V3 improves exterior composition, foliage, architectural detail and the scout's posture without changing collision or match rules. Walk/Run lower-body motion derives from the selected CMU capture; the model, rig, weapon poses and six other actions remain original. Source provenance, a public credit notice and separate motion-data terms are included; `.gitattributes` preserves the exact publisher bytes. The motion is not CC0 or a directly resellable animation pack.

The animation controller uses measured playback rates, world-up leg turns, matching gait phase/rate and interruptible pose weights. A grounded two-bone leg constraint handles transition penetration. Replaying a completed Jump retains its outgoing pose in one reusable donor while a fresh one-shot begins. Validate source/exported geometry, complete controller transitions and actual rendered input separately; a positive source-frame clearance alone does not prove blending is correct.

[ART_DEPTH.md](ART_DEPTH.md) records V3's completed art/controller checks and remaining limits. Its implementation/CI identity, deployment and origin/public verification belong to the release record, separately from V2's evidence.

## Internet release gates

The completed gates below apply to deployed V3. Physical-device and family playtests remain open.

1. **Complete:** user approved Coastline; dedicated container, persistent SQLite volume, restart policy, resource limits, and loopback origin `127.0.0.1:14350` are running. The pre-release online SQLite backup passed integrity checks, and existing profiles, crews, memberships, and results were preserved. Backup/recovery procedures are documented; recurring off-host backups are not configured.
2. **Complete implementation and origin checks:** V3 passed 79 automated tests and separate asset/controller/real-input checks. Implementation release `884e24d` was verified at the origin with the exact merged revision, healthy status, zero restarts and passing HTTP/WebSocket smoke checks. `/health` remains authoritative for the current build. See the release record for the scope of each test.
3. **Complete public entry points and rendered practice:** `kpop.8westventures.com` routes through the existing Cloudflare Tunnel to HTTP `127.0.0.1:14350`. Public HTTPS, the built client, secure WebSocket transport and both model hashes passed verification. [Live rendered Balanced practice](verification/sunbreak-v3-live.json) verified exact release `884e24d`, all three rivals moving/firing, one download per matching V3 model and explicit exit without application errors. Verify actual device play and invitations across separate connections below.
4. **Pending real devices:** test actual iPhone/Safari, Android/Chrome, and intended desktops. Record frame rates and controls; tune touch ergonomics with the players.
5. **Pending family playtest:** play from two separate internet connections, including brief disconnection/recovery. Two tabs and emulated mobile sizes cannot prove this gate.

## After the first playtest

The live mobile/recovery behavior handles interrupted touch gestures, stale controls after backgrounding, unwanted graphics downgrades on resume, stalled connection retries, host recovery, finished-result replay, and simultaneous-hit fairness. These changes do not establish physical-phone or wide-area play acceptance; hit testing still has no rewind/lag compensation.

Tune weapon balance, healing, spawns, phone aim assistance, and map routes using observed gameplay. Improve animation/environment detail within the mobile budget. Add content after the core game loop is enjoyable and reliable.
