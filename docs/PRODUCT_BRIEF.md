# Product brief

Give a father and son an enjoyable competitive game while apart, with invited friends and an ongoing leaderboard. Easy joining, responsive phone and desktop play, and short repeatable matches are the priorities.

## Approved starting design

- Third-person, over-the-shoulder camera; no building.
- Browser delivery on phones and desktops, touch and keyboard/mouse.
- Public or private free-for-all, up to eight people, five minutes or first to 15 eliminations. Casual matches can fill to four participants with bots and start with one person.
- Three-second respawns with full starting loadout, 100 health, and 50 shield.
- Two-second spawn protection, ending on weapon fire.
- Slot 1 AR, slot 2 shotgun, slot 3 two healing charges per life.
- Each heal restores 50 health after three seconds. Damage or weapon fire interrupts it; activated charges are consumed.
- Crew ratings, wins, matches, eliminations, deaths, win rate, monthly/all-time standings, five-match placements, and match history.
- Rematches, readiness after the current arena renders, a full three-second countdown, and clear waiting, connection, and error states.
- Original Blender-created rigged models with human proportions and believable movement. Armor remains stylized; source and third-party motion rights are documented.

## Current content

The current content is [Kannon Town and mobile controls](KANNON_TOWN.md), responding to Kannon's report of stuck iPhone movement and difficulty aiming while firing. The game address is [kpop.8westventures.com](https://kpop.8westventures.com); [/health](https://kpop.8westventures.com/health) identifies the running revision and map version. The [release record](RELEASE.md) separates current and historical acceptance.

After host start or rematch, each human waits for their current prepared round to render and selects **Ready to play**. Desktop players capture the mouse with that action; touch players do not generate a gameplay input. Everyone's readiness begins the full three-second countdown. Focus loss, a menu or reconnect during preparation requires a fresh gesture; a 45-second timeout returns the players to the lobby with an explanation. Once countdown begins, the existing live-round clock and protection rules apply. Older pages receive a refresh instruction instead of entering an unsupported wait.

The scout retains its integrated shoulders, upper-back cloth, refined Walk/Run ground contacts, rig and six other clips. Animation follows visible travel, and client prediction respects reload/heal sprint restrictions. Kannon Town replaces the old collision map and practice navigation; movement speeds, loadout, scoring and combat rules remain unchanged.

The original model, rig, weapon poses and six actions are retained. Walk/Run lower-body motion uses credited CMU capture retargeted in Blender. The [source notice](../art/source/motion/cmu-09/CMU-USAGE-NOTICE.md) explains its separate rights: the motion is not CC0 and cannot be resold directly as motion data. These assets do not establish photorealism, perfect foot locking or parity with Fortnite.

Kannon Town is the only playable map: two facing two-story houses, garages, upstairs windows, rear balconies/yards, and central bus/truck cover. Its compact neighborhood arrangement follows the requested Nuketown reference using original Blender geometry and materials. Perfect this map before adding another. The AR has 30 rounds and the shotgun six; both have unlimited reserve and server-controlled reloads. Everyone receives the same equipment.

On phones, the left side moves and the right side aims. Simple mode defaults to automatic fire after the crosshair rests on a visible rival. Advanced provides manual Fire that can be held and dragged to aim. Healing always needs a deliberate tap. Optional gyroscope aiming is enabled in Settings.

Casual games never affect ratings. Solo practice is a complete round against three named AI rivals: Scout, Moxie, and Rook. Choose **Play against bots → difficulty → Create bot match → Enter bot match → Ready to play**. Relaxed gives slower reactions and more aim error, Balanced is the default, and Challenging responds faster and aims more accurately. Weapons, health, healing, protection, respawns, and the five-minute/15-elimination rules stay the same. Rivals compete with each other as well as the human player and can win or share a draw. Rematches retain difficulty.

Rivals patrol and use cover, react to visible opponents, reload, heal, and choose between AR and shotgun by distance. Navigation covers both houses, four stair routes and the open truck, so visible upper opponents can prompt ascent. Rivals return through the stairs and do not jump or perform general climbing. Bot actions stop when no human is connected; the server match clock continues.

Bot matches never create persistent bot profiles, saved match history, or rating updates. The human player's normal saved profile is still used. Solo bot rooms remain private and solo; casual private or public matches can fill empty lobby seats with the same AI rivals. Humans replace bots until four people have joined, with room for up to eight people. Ranked crew matches stay private and human-only.

**Available Games** lists public lobbies with room for more people and offers a direct **Join** button without an invitation. It shows the host nickname, player count, and bot settings, refreshes automatically while visible, and handles games that fill up or start before a join completes. Full, empty disconnected, expired, preparing, playing, and finished matches are not listed. Hosts choose Public explicitly when creating a room; Private is the default. There is no progression grind or purchase requirement.

## Remote play

Both clients connect outward to one hosted server over HTTPS/WSS without household router port forwarding. The server owns membership, movement validation, weapons, health, scores, and results. Room invitations expire; friend-crew membership controls ranked games and leaderboard access.

Browser regressions exercise independent native touch contacts, release/cancel recovery, server-confirmed movement stop, Simple and Advanced firing, and WebKit touch lifecycle. Map tests cover spawn-to-upstairs navigation, shared collision and bounded practice rounds at all three difficulties. These are separate from Kannon's real iPhone feedback and the intended family network conditions.

The first family feedback reports that general gameplay feels good, but iPhone movement can latch and manual aim/fire is difficult. After this update, repeat those exact actions on the actual iPhone and complete a friends match, checking results and standings. Use the [family playtest guide](FAMILY_PLAYTEST.md). Browser emulation does not establish physical-device frame rates, gyro feel, wide-area latency or concurrent-room capacity. Hit testing still uses current server positions without rewind/lag compensation.

## Deferred scope

Automatic matchmaking, joining a match already in progress, shrinking battle-royale arenas, additional weapons/maps, advanced AI climbing/jumping, voice/chat, progression, purchases, controller support, and console clients remain outside the current scope.

## Success

Both intended players join from different homes on their actual devices, complete a match, see consistent results and correct leaderboard changes, and rematch without developer assistance. Local automated testing does not substitute for that family playtest.
