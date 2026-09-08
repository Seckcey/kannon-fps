# Delivery and acceptance

## Current release

[Ready before the round](ROUND_READINESS.md), merged through [PR #8](https://github.com/Seckcey/kannon-fps/pull/8) as `979601a88b7a5ea574fed817c1686bf327fe4acf`, is deployed at [kpop.8westventures.com](https://kpop.8westventures.com). [/health](https://kpop.8westventures.com/health) identifies the running build, including later documentation closeouts. The origin remains HTTP `127.0.0.1:14350`.

The server prepares a full visible loadout and frozen clock before countdown. Every human first renders that same prepared round and selects **Ready to play**. Desktop mouse capture is confirmed before acknowledgment and retained through the full countdown; gameplay inputs remain blocked until play. Rematches need fresh engagement. Timeout, reconnect, withdrawal and older-page handling are explicit. This changes entry transport and input lifecycle while preserving the Blender models, combat rules, map, weapons, movement and scoring.

All 155 tests, asset/type/build checks and [merged-main CI](https://github.com/Seckcey/kannon-fps/actions/runs/34239819735) passed. [Local browser evidence](verification/round-readiness-local.json) records four development and three production-build Edge groups with real keyboard/mouse and emulated touch controls. Actual parse delay/failure was instrumented only in development; both modes delayed rematch world messages and verified native capture after an intentional refusal. The initial in-app capture did not succeed and its cause remains unproven, so it is not counted as capture acceptance. See the [release record](RELEASE.md) for implementation, Linux/public evidence and limitations.

## Internet release gates

1. **Complete infrastructure:** the user-approved Coastline container has dedicated persistent SQLite storage, resource/security limits, restart policy and loopback origin. An online backup and preservation checks passed. Backup/recovery procedures are documented; recurring off-host backups are not configured.
2. **Complete implementation and origin checks:** exact merged `979601a` passed [deployment verification](verification/round-readiness-deployment.json), preserving prior data, protected services, backups, images and both models. CI builds the Linux image and tests its unprivileged HTTP/WebSocket entry points. [Isolated Linux acceptance](verification/round-readiness-linux.json) held seven of eight humans ready for 3,224 ms with the clock still at 300, then started a fresh three-second countdown after the eighth acknowledgment. A 60-second run sent 14,394 inputs and produced 1,291 AR and 165 shotgun shots. Recovery, capacity and all three practice difficulties passed without unexpected errors.
3. **Complete public rendered acceptance:** [HTTPS/WSS acceptance](verification/round-readiness-live.json) verified exact implementation `979601a` and its bundle. The rendered arena remained unready across 57 fresh snapshots and 3,799 ms of server time. Native capture remained through the 3,053 ms observed countdown; both unchanged models downloaded once, all three rivals moved and fired, and explicit exit was clean. The short sample observed 15 AR shots, no shotgun shots, nine damage events and one shield break. Application errors were absent; known sky and Cloudflare beacon CSP diagnostics remain recorded.
4. **Pending real devices:** test the intended phones and desktops. Record phone models, smoothness, aim feel and visibility; tune touch controls with the players. Desktop fixtures and emulated layouts cannot prove physical-phone performance.
5. **Pending family playtest:** follow the [family playtest guide](FAMILY_PLAYTEST.md) from two separate internet connections, including a brief disconnect/recovery. Two local tabs cannot prove this gate.

## Retained foundations

The preceding [grounded Scout movement release](SCOUT_GROUNDED_GAIT.md) refined Blender Walk/Run contacts, loop motion and knee direction while preserving its rig budget and six other actions. Its 133-test, 16-controller-case, four-renderer-scene and independent comparison records remain historical evidence. Four proposed reverse-stance drift limits remained exceeded; no perfect foot locking or Fortnite-parity claim follows from that release.

The [previous scout release](SCOUT_MOTION_POLISH.md) introduced fitted shoulders, movement following visible collision/interpolation travel, confirmed reload/heal prediction and the existing south stair route. Its desktop/touch, eight-moving-character and isolated Linux results remain historical evidence with their original models and source. [Combat feedback](COMBAT_FEEDBACK.md), [V3 art](ART_DEPTH.md) and the earlier practice release are recorded separately in [Release verification](RELEASE.md).

Solo practice retains three rivals and Relaxed, Balanced and Challenging difficulty. Use **Practice first → choose difficulty → Create practice → Enter practice → Ready to play**. Bots use the same loadout, combat and respawn rules, can win or draw, and keep difficulty across rematches. They can use the existing stairs but do not jump or perform general climbing. Practice never writes bot profiles or ranked results. Room entry retains downloaded model bytes and cancels stale admission work after leaving or changing players. Countdown also waits for the matching prepared round to render and each human's deliberate readiness.

The credited CMU capture supplies the lower-body Walk/Run motion; the model, rig, surfaces, weapon poses and six other actions are original. Provenance and separate motion terms remain included. The motion is not CC0 or a directly resellable animation pack.

## After the first playtest

The existing recovery behavior handles interrupted gestures, backgrounding, stalled connections, host recovery and finished-result replay. Hit testing still has no server rewind/lag compensation. Physical devices and wide-area play need direct acceptance.

Tune weapon balance, healing, spawns, phone aim assistance and map routes using observed gameplay. Continue animation/environment improvements within the phone budget, then add content once the core loop is enjoyable and reliable.
