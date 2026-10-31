# Product brief

Give a father and son a fun competitive game to play while apart, with invited friends and an ongoing leaderboard. Easy joining, responsive phone and desktop play, and short matches you want to play again are the priorities.

## The game today

On October 30, 2026 Frank asked for the game to look and play like a modern military shooter. The [first-person overhaul](superpowers/specs/2026-10-30-first-person-combat-overhaul-design.md) keeps who the game is for and changes how it plays and looks:

- First person for everyone. You see your hands and your weapon; other players are full soldiers. No building.
- In the browser on phones and desktops, with touch or keyboard and mouse.
- **Free-for-all** (first to 15 eliminations) or **Team Deathmatch** (two teams, first team to 30). Five-minute rounds. Public or private rooms for up to eight people. Casual rooms can fill to four players with bots and start with one person.
- 100 health that starts to refill 4 seconds after you were last hit (2.5 seconds with the Second Wind perk). No shield and no healing items.
- 3-second respawns with full ammo and a frag grenade. 1.5 seconds of spawn protection, which ends when you fire, throw a grenade or use the knife.
- Classes: **Assault** with the KR-5 Carbine, **Close Quarters** with the Hornet 9, **Marksman** with the Heron 7 bolt-action rifle, or **Custom** with any primary (including the Breaker 12 pump shotgun) and one perk from each slot. Everyone carries the Sentry 9 pistol, a frag grenade and a knife.
- Perks by slot: Quick Hands or Deep Pockets; Quiet Step or No Trace; Second Wind or Cool Head.
- Rewards for eliminations in a row: Recon Sweep (3), Mortar Volley (5) and Attack Drone (7). Medals with our own names, such as Bullseye for a headshot.
- Sprint, a short stamina-limited dash, crouch, slide, jump and vault over low walls.
- A HUD of our own: minimap, kill feed, hit markers, damage direction, ammo and reward panel, scoreboard and an "eliminated by" card.
- Crew ratings, wins, matches, eliminations, deaths, win rate, monthly and all-time standings, five placement matches and match history. Ranked crew matches are free-for-all only; Team Deathmatch is always casual.
- Rematches, a **Ready to play** step after your arena has drawn, a full three-second countdown, and clear waiting, connection and error messages.
- The rule for content: our own weapon, perk, reward and medal names and our own screens, a map we built ourselves, and no logos, branding or assets from other games. No gore: hits show dark puffs and screen effects.

## Current content

[Kannon Town v3](TOWN_V3.md) is the only map. It is the same street as before: two facing two-storey houses, garages, upstairs windows, back balconies and yards, and the bus and truck in the middle. It is now dressed as a military checkpoint after an evacuation, with new sandbag walls and concrete barriers for cover, crate stacks, glass and pots that break, and a low late-afternoon sun. Perfect this map before adding another. The game address is [kpop.8westventures.com](https://kpop.8westventures.com); [/health](https://kpop.8westventures.com/health) shows the running revision and map version (`kannon-town-v3`). The [release record](RELEASE.md) keeps current and earlier checks apart.

Other players are [soldiers in dark gear](OPERATOR_ART.md) with a team-coloured patch, and you hold [original weapons in gloved hands](WEAPONS_ART.md). The soldier and the weapons are our own designs, made in Blender from code. The town is our own Blender work too, dressed with free (CC0) photo textures and twenty free (CC0) props, such as trash cans, street lamps and a picnic table, all from Poly Haven. It all looks grittier and more realistic than before, but it does not match the scanned art of a large studio. Walk and run leg motion uses credited CMU motion capture; the [source notice](../art/source/motion/cmu-09/CMU-USAGE-NOTICE.md) explains its separate rights. That motion is not CC0 and cannot be resold as motion data.

After the host starts or rematches, each person waits for the round to draw and selects **Ready to play**. On a desktop that also captures the mouse; on a phone it does not fire or move you. When everyone is ready, the full three-second countdown begins. Losing focus, opening a menu or reconnecting while the round is getting ready needs a fresh Ready; after 45 seconds the players go back to the lobby with an explanation. This release changes the town, so pages left open from before it are told to refresh before they can start or play.

On phones, a stick on the left moves you; push it all the way forward to sprint and again to dash. The right side aims. There are two Fire buttons, plus Aim, Crouch, Jump, Reload, Grenade, Knife and Swap (and Sprint if you turn off automatic sprint), and a button for each reward you have earned. **Simple** firing, the default, shoots for you once the crosshair rests on a visible rival; **Advanced** lets you hold Fire and drag it to aim. Gyroscope aiming can be turned on in Settings.

Casual games never change ratings. Solo practice is a full round against three AI rivals: Scout, Moxie and Rook. Choose **Play against bots → difficulty → Create bot match → Enter bot match → Ready to play**. Relaxed is slower and less accurate, Balanced is the default, and Challenging reacts faster and aims better. The rivals fight each other as well as you, and they can win or draw. Rematches keep the difficulty.

Rivals carry class loadouts, take cover and back off to let their health refill, reload when out of sight, use the knife up close and use their rewards. On Balanced and Challenging they also throw frag grenades and dash; on Challenging they sometimes slide into a fight. They move through both houses, all four stairs and the open truck, but they do not jump or vault. They stop acting when no person is connected; the match clock keeps running.

Bot matches never create bot profiles, saved match history or rating changes. Your normal saved profile is still used. Solo bot rooms are private. Casual private or public matches can fill empty seats with the same rivals; people take a bot's place until four people have joined, with room for up to eight. Ranked crew matches are private and people only.

**Available Games** lists public lobbies with room for more people and a **Join** button that needs no invitation. It shows the host's nickname, the mode, the number of people and bots, and refreshes while you look at it. Full, empty, expired, starting, playing and finished matches are not listed. Hosts choose Public on purpose when they create a room; Private is the default. There is no grind and nothing to buy.

## Remote play

Both players connect out to one hosted server over HTTPS and WSS, so no home router needs port forwarding. The server decides membership, movement, weapons, health, scores and results. Your own movement and shots show on your screen at once and the server confirms them. To make shots count where you saw the target, the server checks each shot against where opponents were on the shooter's screen, up to 400 ms in the past. Room invitations expire; crew membership controls ranked games and leaderboard access.

Automated tests cover touch and mouse input, movement, vaulting and grenades, damage falloff and hit zones, every weapon's fire rate, rewards, team play and full bot rounds at every difficulty. They do not replace a real phone or the family's home internet. Browser emulation does not prove real-phone frame rates, gyroscope feel, long-distance latency or how many rooms the server can run at once.

The first family playtest found that the game felt good but that iPhone movement could stick and aiming while firing was hard; both were addressed before this overhaul, but only a real iPhone can confirm it. After the overhaul, repeat a full friends match on the real iPhone and desktop with the [family playtest guide](FAMILY_PLAYTEST.md), and compare results and standings.

## Deferred scope

Automatic matchmaking, joining a match already in progress, battle royale, more maps, a capture-point mode, ledge hanging, pipe climbing and going prone, bots that jump or climb, voice or text chat, progression, purchases, controller support and console clients are outside the current scope.

## Success

Both players join from different homes on their own devices, finish a match, see the same results and correct leaderboard changes, and rematch without help from a developer. Automated testing does not replace that family playtest.
