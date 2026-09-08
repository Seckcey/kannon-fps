# Delivery and acceptance

## Current release

[Grounded Scout movement](SCOUT_GROUNDED_GAIT.md), merged through [PR #7](https://github.com/Seckcey/kannon-fps/pull/7) as `c0d7f12957123b105c7e961c8cb8b1ba160cfab6`, is deployed at [kpop.8westventures.com](https://kpop.8westventures.com). [/health](https://kpop.8westventures.com/health) identifies the running build including later documentation closeouts. The origin remains HTTP `127.0.0.1:14350`.

The Blender Walk/Run refinement reduces near-floor sliding and loop velocity changes and stabilizes the captured knee direction near extension. The model retains its polygon/rig/draw budgets and six other actions. Gameplay, shared simulation, runtime controllers, map, weapons and scoring are unchanged. Four proposed reverse-stance material-point drift limits remain exceeded and are recorded as a bounded tradeoff; there is no perfect foot-locking or Fortnite-parity claim.

All 133 tests, asset/type/build checks and [merged-main Linux CI](https://github.com/Seckcey/kannon-fps/actions/runs/34232619677) passed. The final actual controller passed 16 cases/2,268 samples, and four moving renderer scenes loaded the exact model without application errors. The independent comparison passes all 64 correctness checks and 116/120 proposed improvement checks. See the [release record](RELEASE.md) for exact identities, evidence and limitations.

## Internet release gates

1. **Complete infrastructure:** the user-approved Coastline container has dedicated persistent SQLite storage, resource/security limits, restart policy and loopback origin. An online backup and preservation checks passed. Backup/recovery procedures are documented; recurring off-host backups are not configured.
2. **Complete implementation and origin checks:** exact merged `c0d7f12` passed [deployment verification](verification/scout-grounded-deployment.json), including data, protected services, health and models. CI builds the Linux image and tests its unprivileged HTTP/WebSocket entry points. No new transport/controller code required repeating the earlier multi-client load test.
3. **Complete public rendered practice:** [HTTPS/WSS acceptance](verification/scout-grounded-live.json) verified the exact bundle and two models, all three rivals moving and firing, and explicit exit. The sample observed 23 AR shots, no shotgun shots, 12 damage events and two shield breaks. Application errors were absent; known sky and external analytics CSP diagnostics remain recorded.
4. **Pending real devices:** test the intended phones and desktops. Record phone models, smoothness, aim feel and visibility; tune touch controls with the players. Desktop fixtures and emulated layouts cannot prove physical-phone performance.
5. **Pending family playtest:** follow the [family playtest guide](FAMILY_PLAYTEST.md) from two separate internet connections, including a brief disconnect/recovery. Two local tabs cannot prove this gate.

## Retained foundations

The [previous scout release](SCOUT_MOTION_POLISH.md) introduced fitted shoulders, movement following visible collision/interpolation travel, confirmed reload/heal prediction and the existing south stair route. Its desktop/touch, eight-moving-character and isolated Linux results remain historical evidence with their original models and source. [Combat feedback](COMBAT_FEEDBACK.md), [V3 art](ART_DEPTH.md) and the earlier practice release are recorded separately in [Release verification](RELEASE.md).

Solo practice retains three rivals and Relaxed, Balanced and Challenging difficulty. Use **Practice first → choose difficulty → Create practice → Enter practice**. Bots use the same loadout, combat and respawn rules, can win or draw, and keep difficulty across rematches. They can use the existing stairs but do not jump or perform general climbing. Practice never writes bot profiles or ranked results. Room entry retains downloaded model bytes and cancels stale admission work after leaving or changing players.

The credited CMU capture supplies the lower-body Walk/Run motion; the model, rig, surfaces, weapon poses and six other actions are original. Provenance and separate motion terms remain included. The motion is not CC0 or a directly resellable animation pack.

## After the first playtest

The existing recovery behavior handles interrupted gestures, backgrounding, stalled connections, host recovery and finished-result replay. Hit testing still has no server rewind/lag compensation. Physical devices and wide-area play need direct acceptance.

Tune weapon balance, healing, spawns, phone aim assistance and map routes using observed gameplay. Continue animation/environment improvements within the phone budget, then add content once the core loop is enjoyable and reliable.
