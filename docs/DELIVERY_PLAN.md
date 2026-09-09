# Delivery and acceptance

## Current work

The first family playtest found stuck iPhone movement and difficulty aiming while firing; the rest of the game felt good. [Kannon Town and mobile controls](KANNON_TOWN.md) addresses that feedback and replaces Sunbreak with one compact neighborhood map. Perfect this map before adding any others.

Play at [kpop.8westventures.com](https://kpop.8westventures.com). [/health](https://kpop.8westventures.com/health) identifies the running revision and world version. Coastline's origin remains HTTP `127.0.0.1:14350`, behind the existing Cloudflare Tunnel. [Release verification](RELEASE.md) separates current and historical checks.

## Acceptance

1. **Automated correctness:** 172 client/server/transport tests, asset validation, TypeScript and production build pass. Map tests cover every spawn to both upstairs floors, all stair/access routes, support/occlusion and complete bounded practice rounds at every difficulty.
2. **Browser input:** native Chromium multi-touch proves movement release while a separate finger aims, missed pointer-release recovery, cancellation and Fire dragging. The production bundle confirms stopped server velocity without respawn and automatic shots and hits without pressing Fire. WebKit touch lifecycle is covered separately. These do not prove physical iPhone performance or sensor behavior.
3. **Release:** use CI, an integrity-checked online backup and scoped Coastline deployment. Preserve existing data, older backups/images, runtime security limits and unrelated services. Match the health revision to the image; verify exact public map and Scout hashes and HTTPS/WSS entry.
4. **Kannon's iPhone retest:** refresh both devices and follow the [family guide](FAMILY_PLAYTEST.md). Lift the movement thumb while keeping the aiming thumb down. Try Simple, Advanced and optional gyro. Compare results and crew standings after a complete friends match and rematch.

## Retained foundations

Each player sees the prepared arena and selects **Ready to play** before the full three-second countdown. Reconnect, preparation timeout, explicit leave and rematch recovery remain. Old map clients receive a refresh instruction before starting or sending input into the new world.

Solo practice retains three rivals and Relaxed, Balanced and Challenging difficulty. Rivals use ordinary combat rules and can win or draw. They navigate both houses and all supported stairs without general climbing or jumping. Practice creates no bot profiles, ranked results or saved match history. Friends matches contain human players only.

The existing Blender Scout and credited CMU Walk/Run motion remain unchanged. Historical graphics, animation and performance records retain their original source revisions and limitations.

## Next iteration

Tune this map's sightlines, spawns and cover from family matches. Tune touch sensitivity and gyro feel from the intended phones, then improve animation and environment detail within the phone budget. Hit testing still has no server rewind. Recurring off-host backups and broad concurrent-room capacity are not established by this release. Additional maps remain deferred until Kannon Town feels right.
