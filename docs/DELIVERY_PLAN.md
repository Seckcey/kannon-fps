# Delivery and acceptance

## Live Sunbreak V2 release

The live Sunbreak V2 implementation was introduced in verified release [`bd58bd3`](https://github.com/Seckcey/kannon-fps/commit/bd58bd35723f8f7b9bb10b58914784b26909533e), merged through [PR #3](https://github.com/Seckcey/kannon-fps/pull/3) and deployed on Coastline at [kpop.8westventures.com](https://kpop.8westventures.com). The [/health](https://kpop.8westventures.com/health) endpoint is the canonical current deployed build identity, including later documentation closeouts. Sunbreak includes the approved third-person view, fixed loadout/healing, respawns/protection, server-owned multiplayer, private invitations/crews, persistent rankings/history, keyboard/mouse and touch interfaces, plus the coastal environment and active solo practice rivals. Blender source, a skinned glTF model, eight clips and reproducible generation/validation scripts are included. V2 shipped stylized armor/scenery and hand-keyed animation.

V2 validation included TypeScript, simulation/storage regressions, HTTP/WebSocket acceptance, asset checks and the [successful main CI run](https://github.com/Seckcey/kannon-fps/actions/runs/34198117228). Browser acceptance separately exercised rendered menus and gameplay. These results belong to that release, not automatically to a later candidate. See the [release record](RELEASE.md) for exact results and limitations.

## Visual and practice upgrade

The deployed upgrade adds three active practice rivals with Relaxed, Balanced, and Challenging difficulty. The entry flow is **Practice first → choose difficulty → Create practice → Enter practice**. Bots use the existing loadout/combat/respawn rules, can win or draw, and keep difficulty across rematches. They follow ground routes around cover and platforms; jumping and climbing remain outside this slice. Practice never writes bot profiles or ranked results.

Room entry prepares retained GLB bytes before admission, then reuses those bytes for rendering. Failed downloads can retry without refetching successful assets. Replacing the player or leaving cancels stale entry work, so a delayed download cannot enter a room as a previous identity.

Focused automated checks cover AI perception, navigation and corner recovery, reaction/aim differences, weapons/healing, match outcomes, rematches, disconnect suspension, invalid settings, persistent-data isolation, asset sharing, timeout/retry, and damaged GLB responses. A seeded match simulation checks movement/collider safety and bounded server work. Rendered acceptance passed all nine groups on the final candidate with no app errors. An isolated Linux candidate also passed a real 60-second eight-player combat/reconnect test and all three practice difficulties. These measurements do not establish physical-phone frame rates, wide-area performance, or capacity for multiple simultaneous rooms.

## Art-depth candidate — pending release

The current candidate improves exterior composition, foliage, architectural detail and the scout's posture without changing collision or match rules. Walk/Run lower-body motion derives from the selected CMU capture; the model, rig, weapon poses and six other actions remain original. Source provenance, a public credit notice and separate motion-data terms are included; `.gitattributes` preserves the exact publisher bytes. The motion is not CC0 or a directly resellable animation pack.

The animation controller uses measured playback rates, world-up leg turns, matching gait phase/rate and interruptible pose weights. A grounded two-bone leg constraint handles transition penetration. Replaying a completed Jump retains its outgoing pose in one reusable donor while a fresh one-shot begins. Validate source/exported geometry, complete controller transitions and actual rendered input separately; a positive source-frame clearance alone does not prove blending is correct.

[ART_DEPTH.md](ART_DEPTH.md) records the candidate's completed checks and remaining limits. Final candidate/CI identity, deployment, origin/public verification and closeout belong to its release record. Do not reuse V2's successful deployment or CI as evidence that this candidate has shipped.

## Internet release gates

The completed gates below apply to the live Sunbreak release. Physical-device and family playtests remain open.

1. **Complete:** user approved Coastline; dedicated container, persistent SQLite volume, restart policy, resource limits, and loopback origin `127.0.0.1:14350` are running. The pre-release online SQLite backup passed integrity checks, and existing profiles, crews, memberships, and results were preserved. Backup/recovery procedures are documented; recurring off-host backups are not configured.
2. **Complete candidate and origin checks:** the final candidate passed automated, rendered-browser, and isolated Linux transport acceptance. Implementation release `bd58bd3` was verified at the origin with the exact merged revision, healthy status, zero restarts, and passing HTTP/WebSocket smoke checks. `/health` remains authoritative for the current build. See the release record for the scope of each test.
3. **Complete public entry points and practice:** `kpop.8westventures.com` routes through the existing Cloudflare Tunnel to HTTP `127.0.0.1:14350`. Public HTTPS, the built client, and secure WebSocket transport passed smoke checks. Public rendered practice verified both model hashes, one download per model, three moving/firing rivals, and explicit exit without app errors. Verify actual device play and invitations across separate connections below.
4. **Pending real devices:** test actual iPhone/Safari, Android/Chrome, and intended desktops. Record frame rates and controls; tune touch ergonomics with the players.
5. **Pending family playtest:** play from two separate internet connections, including brief disconnection/recovery. Two tabs and emulated mobile sizes cannot prove this gate.

## After the first playtest

The live mobile/recovery behavior handles interrupted touch gestures, stale controls after backgrounding, unwanted graphics downgrades on resume, stalled connection retries, host recovery, finished-result replay, and simultaneous-hit fairness. These changes do not establish physical-phone or wide-area play acceptance; hit testing still has no rewind/lag compensation.

Tune weapon balance, healing, spawns, phone aim assistance, and map routes using observed gameplay. Improve animation/environment detail within the mobile budget. Add content after the core game loop is enjoyable and reliable.
