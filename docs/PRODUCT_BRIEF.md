# Product brief

Give a father and son an enjoyable competitive game while apart, with invited friends and an ongoing leaderboard. Easy joining, responsive phone and desktop play, and short repeatable matches are the priorities.

## Approved starting design

- Third-person, over-the-shoulder camera; no building.
- Browser delivery on phones and desktops, touch and keyboard/mouse.
- Private 2–8 player free-for-all, five minutes or first to 15 eliminations.
- Three-second respawns with full starting loadout, 100 health, and 50 shield.
- Two-second spawn protection, ending on weapon fire.
- Slot 1 AR, slot 2 shotgun, slot 3 two healing charges per life.
- Each heal restores 50 health after three seconds. Damage or weapon fire interrupts it; activated charges are consumed.
- Crew ratings, wins, matches, eliminations, deaths, win rate, monthly/all-time standings, five-match placements, and match history.
- Rematches and clear waiting, connection, and error states.
- Original Blender-created rigged models with human proportions and believable movement. Armor remains stylized; source and third-party motion rights are documented.

## Current content

The [grounded Scout movement release](SCOUT_GROUNDED_GAIT.md) is live at [kpop.8westventures.com](https://kpop.8westventures.com). Source `30d1f9d` merged through [PR #7](https://github.com/Seckcey/kannon-fps/pull/7) as [`c0d7f12`](https://github.com/Seckcey/kannon-fps/commit/c0d7f12957123b105c7e961c8cb8b1ba160cfab6), with [successful main CI](https://github.com/Seckcey/kannon-fps/actions/runs/34232619677). [/health](https://kpop.8westventures.com/health) identifies the running build, including later documentation closeouts. All 133 tests, asset/type/build checks, 16 actual-controller cases and public rendered practice passed. The [release record](RELEASE.md) separates this animation update from prior desktop/touch input, Linux traffic and performance evidence.

The scout retains its integrated shoulders and upper-back cloth. Walk and Run now use refined ground-contact and knee motion, with less sliding and smaller loop velocity changes; six other clips and the rig are preserved. Movement animation follows visible travel after collision, client prediction respects confirmed reload/heal sprint restrictions, and practice rivals can use the existing south stairs and platform. The map, gameplay movement, loadout, scoring and earlier combat feedback are unchanged.

The deployed [art-depth upgrade](ART_DEPTH.md) improves coastal scenery, architecture and the scout's athletic stance while preserving the game rules and collision. Walk/Run lower-body movement now uses credited CMU motion retargeted in Blender; the model, rig, weapon poses and six other actions remain original. The [retained source notice](../art/source/motion/cmu-09/CMU-USAGE-NOTICE.md) explains its separate rights: the motion is not CC0 and cannot be resold directly as motion data. Rapid direction changes, aimed movement, interrupted transitions and grounded foot placement are handled by the animation controller. These changes target more convincing motion; they do not establish photorealism, perfect foot locking or parity with Fortnite.

Sunbreak Courtyard is a sunny coastal arena with shared collision, cover, stepped elevation, and multiple routes. The AR has a 30-round magazine and the shotgun six rounds; both have unlimited reserve and server-controlled reloads. Everyone receives the same equipment.

Casual games never affect ratings. Solo practice is a complete round against three named AI rivals: Scout, Moxie, and Rook. Choose **Practice first → difficulty → Create practice → Enter practice**. Relaxed gives slower reactions and more aim error, Balanced is the default, and Challenging responds faster and aims more accurately. Weapons, health, healing, protection, respawns, and the five-minute/15-elimination rules stay the same. Rivals compete with each other as well as the human player and can win or share a draw. Rematches retain difficulty.

Rivals patrol and use cover, react to visible opponents, reload, heal, and choose between AR and shotgun by distance. Deployed navigation includes supported routes through the existing south stairs/platform, so visible upper opponents can prompt ascent. Rivals return through the stairs and do not jump or perform general climbing. Bot actions stop when no human is connected; the server match clock continues.

Practice never creates persistent bot profiles, saved match history, or rating updates. The human player's normal saved profile is still used. Practice rooms remain solo; private friends matches contain human players only. There is no progression grind or purchase requirement.

## Remote play

Both clients connect outward to one hosted server over HTTPS/WSS without household router port forwarding. The server owns membership, movement validation, weapons, health, scores, and results. Room invitations expire; friend-crew membership controls ranked games and leaderboard access.

Public HTTPS/WSS entry points and [rendered practice](verification/scout-grounded-live.json) verified exact implementation `c0d7f12`, the grounded Scout model and three moving/firing rivals without application errors. Known sky and CSP warnings were recorded separately. [Deployment evidence](verification/scout-grounded-deployment.json) records that implementation and preservation checks; [/health](https://kpop.8westventures.com/health) identifies the running revision including later documentation closeouts. Actual iPhone/Safari, Android/Chrome, intended-desktop controls and performance, and a two-household match still need the players' acceptance. Use the [family playtest guide](FAMILY_PLAYTEST.md). Browser emulation and the earlier constrained Linux loopback load test do not establish device frame rates, wide-area latency, or capacity for multiple concurrent rooms. Hit testing uses current server positions without rewind/lag compensation.

## Deferred scope

Public matchmaking, shrinking battle-royale arenas, additional weapons/maps, bots in friends matches, advanced AI climbing/jumping, voice/chat, progression, purchases, controller support, and console clients remain outside the current scope.

## Success

Both intended players join from different homes on their actual devices, complete a match, see consistent results and correct leaderboard changes, and rematch without developer assistance. Local automated testing does not substitute for that family playtest.
