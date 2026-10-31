# Delivery and acceptance

## Current work

The [first-person overhaul](superpowers/specs/2026-10-30-first-person-combat-overhaul-design.md) turns Kannon Arena into a first-person modern military shooter on the same browser engine, carried out through its [plan](superpowers/plans/2026-10-30-first-person-overhaul.md): Free-for-all and Team Deathmatch, health that refills, classes, perks and rewards, sprint, dash, slide and vault, an original HUD and touch layout, synthesized sound, [Kannon Town v3](TOWN_V3.md) at golden hour, the [operator](OPERATOR_ART.md) and original [weapons](WEAPONS_ART.md). Lobby, readiness, crews, ratings, bots, Available Games and the deployment stay. Perfect Kannon Town before adding another map.

Play at [kpop.8westventures.com](https://kpop.8westventures.com). [/health](https://kpop.8westventures.com/health) identifies the running revision and world version (`kannon-town-v3` for this checkout). Coastline's origin remains HTTP `127.0.0.1:14350`, behind the existing Cloudflare Tunnel. [Release verification](RELEASE.md) separates current and historical checks.

## Acceptance

1. **Automated correctness:** the full test suite, the asset validators, TypeScript and the production build pass. Tests cover weapon cadence, damage falloff and hit zones, lag-compensated hits, health refill and perks, the knife, frags, rewards, Team Deathmatch balance, friendly fire and spawns, malformed and hostile input, movement, slide and vault physics, prediction replay parity, the local weapon, the viewmodel, HUD helpers, touch roles, audio, effects, assets, public-room privacy and admission, readiness and recovery, and full bot rounds at every difficulty.
2. **Browser play:** scripted desktop, phone-sized touch and two-player Team Deathmatch play-tests on a Coastline test copy, and a WebKit render check. These do not prove physical iPhone performance or sensor behaviour.
3. **Release:** use CI, an integrity-checked online backup and the scoped Coastline deployment. Preserve existing data, older backups and images, runtime security limits and unrelated services. Match the health revision and `worldVersion` to the image; verify the public model downloads and HTTPS/WSS entry. Ask players to refresh open pages after the cutover.
4. **Kannon's iPhone retest:** refresh both devices and follow the [family guide](FAMILY_PLAYTEST.md). Check movement release while aiming, Simple and Advanced firing, the new buttons, health refill, rewards and a Team Deathmatch match. Compare results and crew standings after a complete friends match and rematch.

## Retained foundations

Each player sees the prepared arena and selects **Ready to play** before the full three-second countdown. Reconnect, preparation timeout, explicit leave and rematch recovery remain. Pages from an older release receive a refresh instruction before starting or sending input into the new world.

Solo practice keeps three rivals and Relaxed, Balanced and Challenging difficulty. Rivals use ordinary combat rules and can win or draw. They navigate both houses and all supported stairs without jumping, vaulting or climbing. Practice creates no bot profiles, ranked results or saved match history. Casual friends matches can fill to four participants with bots. Public lobbies appear in Available Games until the host starts; private rooms and ranked crews remain invitation-controlled. Ranked crew matches stay free-for-all.

The operator keeps the scout's rig and the credited CMU walk and run leg motion. Historical graphics, animation and performance records keep their original source revisions and limitations.

## Next iteration

Tune weapon damage, recoil, spawns, sightlines and the new cover from family matches. Tune the touch layout, sensitivity and gyroscope feel on the intended phones and measure their frame rate. Check `WS_COMPRESSION` on real iPhones before turning it on in production. Load-test the first-person build under the container limits; the recorded eight-player test was measured on the previous build. Recurring off-host backups and broad concurrent-room capacity are not established. Ledge hanging, pipe climbing, going prone, a capture-point mode and additional maps remain deferred.
