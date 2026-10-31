# Kannon Arena

**Your crew. Your arena.** An original first-person browser shooter for a father, son and invited friends to play on phones and desktops. It plays like a modern military shooter: aim down the sights, sprint, slide, vault, pick a class and earn rewards. There is no building. The repository is still called `kannon-fps`.

## The game

- **Free-for-all** (first to 15 eliminations) or **Team Deathmatch** (two teams, first team to 30). Rounds last five minutes. Up to eight people can play, and bots can fill a small room to four players.
- Public or private rooms, a host who starts the match, and rematches. Each player selects **Ready to play** once the arena has loaded. When everyone is ready, a three-second countdown starts.
- You have 100 health. It starts to refill 4 seconds after you were last hit (2.5 seconds with Second Wind). There is no shield and nothing to heal with.
- You are back 3 seconds after an elimination, with 1.5 seconds of spawn protection. Firing, throwing a grenade or using your knife ends it early.
- If someone's connection drops during a match, their soldier stays where it stopped and can still be hit.
- Pick a class: **Assault** (KR-5 Carbine), **Close Quarters** (Hornet 9), **Marksman** (Heron 7 bolt-action rifle) or **Custom**. Custom lets you pick the primary (KR-5 Carbine, Hornet 9, Breaker 12 pump shotgun or Heron 7) and one perk from each slot. Every class also carries the Sentry 9 pistol, a frag grenade and a knife.
- Perks, one from each pair: **Quick Hands** or **Deep Pockets**; **Quiet Step** or **No Trace**; **Second Wind** or **Cool Head**.
- Rewards for eliminations in a row: **Recon Sweep** at 3, **Mortar Volley** at 5 and **Attack Drone** at 7. Your count goes back to zero when you are eliminated, but a reward you have not used yet stays with you.
- Medals for good moments: First Strike, Double Up, Triple Up, Bullseye, Long Range, Evened Up, Quick Blade, Well Thrown, Drone Down, and Three, Five, Seven and Ten Straight.
- Sprint, dash, crouch, slide, jump, and vault over low walls.
- Keyboard and mouse, or touch controls on phones with optional gyroscope aiming. On phones, **Simple** firing shoots for you when your crosshair rests on a rival.
- **Kannon Town**: one small street with two houses you can go inside, four sets of stairs, upstairs windows, back yards and cover in the middle of the street. It is now a military checkpoint in late-afternoon light.
- **Play against bots** for a match against Scout, Moxie and Rook at Relaxed, Balanced or Challenging.
- **Available Games** lists public lobbies with open seats. Join without an invitation. Private rooms stay hidden.
- Casual hosts can **Fill to 4 players with bots** and start alone. People take the bots' places as they join, up to eight people.
- Saved profiles, private friend crews, monthly and all-time ratings, five placement matches and match history. Ranked crew matches are always free-for-all.

Play at **https://kpop.8westventures.com**. [/health](https://kpop.8westventures.com/health) shows the running commit and `worldVersion`; this checkout uses `kannon-town-v3`. Refresh every open game page after an update. This release changes the town, so a page left open from before it cannot start or play a match. Then try the [family playtest guide](docs/FAMILY_PLAYTEST.md). [Release verification](docs/RELEASE.md) records what was checked for each release.

## Kannon Town, the soldiers and the weapons

[Kannon Town v3](docs/TOWN_V3.md) keeps the same street, houses, stairs and collision as before and adds eight pieces of checkpoint cover: six sandbag walls and two concrete barriers. The old cover piles are now stacks of ammunition crates. The town has a military cargo truck, a faded evacuation bus, a burnt-out car, boarded windows, glass and pots that break when shot, and a low golden-hour sun. [Kannon Town](docs/KANNON_TOWN.md) describes the original layout, and [Kannon Town v2](docs/TOWN_V2.md) the textures and baked light it builds on. Phones load a lighter copy of the town.

Other players appear as [soldiers in dark gear](docs/OPERATOR_ART.md) with a team-coloured patch. Your own view shows [gloved hands and your weapon](docs/WEAPONS_ART.md). The soldier and the weapons are original designs, made in Blender from code. The town is our own Blender work too, dressed with free (CC0) photo textures and twenty free (CC0) props, such as trash cans, street lamps and a picnic table, all from Poly Haven. The look is grittier and more realistic than before, but it is not the scanned art of a large studio game.

The soldiers' walk and run leg motion comes from the CMU Graphics Lab's `09_01` capture, retargeted in Blender. Everything else about the soldier and the weapons is original. The [source notice and separate data terms](art/source/motion/cmu-09/CMU-USAGE-NOTICE.md) and a [public credit notice](public/models/operator-motion-NOTICE.txt) go with the model. The motion is not CC0 and must not be sold as motion data or an animation pack. `.gitattributes` keeps the exact publisher bytes that the provenance hashes check.

## Run locally

Install **Node.js 24 or newer**, then run:

```powershell
npm ci
npm run dev
```

Open **http://localhost:5173**. Choose **Create match**, pick **Free-for-all** or **Team Deathmatch**, choose **Public** or **Private**, and decide whether to **Fill to 4 players with bots**. Public lobbies appear in **Available Games**; private rooms use invitation links or codes. The host can start with one person plus bots, or with at least two people when bots are off. Each player then selects **Ready to play** once the arena appears. Change your class with **Change** under **Your loadout** in the lobby, or during a match from the pause menu or while you wait to respawn (press **L** on a desktop). A change during a match starts with your next life.

To play alone, choose **Play against bots → choose difficulty → Create bot match → Enter bot match → Ready to play**. Balanced is the default. The models download before you enter the room, and later rooms reuse them. The countdown waits until the round has drawn on your screen and you have selected Ready.

On a desktop, Ready also captures the mouse. On a phone, the same button does not fire or move you. Leaving the page, releasing the mouse, opening a menu or reconnecting while the round is getting ready means you need to select Ready again. If a round is not ready within 45 seconds, everyone goes back to the lobby with an explanation. Once the countdown begins, menus and disconnects do not pause the round. If someone has an older game page open, everyone should refresh before starting.

The bots fight each other and you, with the same health and rules. They carry their class weapons, back off to let their health refill, reload when out of sight, use the knife up close, and use their rewards. On Balanced and Challenging they throw frag grenades and dash; on Challenging they also slide into fights. Difficulty changes how fast they react, how well they aim and how they fight; it never gives them extra health or damage. They use the street, both houses, all four stairs and the open truck. They do not jump or vault. Rematches keep the chosen difficulty.

Bot matches and casual bot filling never create bot profiles, saved match results or rating changes; your own saved profile stays as it is. Bots are added in the lobby and before rematches. The bots stay in during play, so a match keeps going against them if a friend leaves. Public games accept new players only while waiting for the host to start. Full, starting, playing, finished, expired and empty rooms are not shown in Available Games.

For two players on one computer, use separate browser profiles or a private window. A saved player can have only one connection at a time; opening the same player in another tab replaces the earlier one.

To test a phone on the same home network, use the Network URL that Vite prints. A firewall or network policy may block it. This does not put the game on the public internet. Copying to the clipboard needs HTTPS or localhost; on a home-network HTTP preview, type room codes in by hand.

## Validate and run production

```powershell
npm run check
npm start
```

`check` runs the client, simulation, storage, HTTP/WebSocket and asset tests, the TypeScript check and the production build. `npm start` serves the built client and server together at **http://127.0.0.1:3001**. Build again after changing the source before using production mode.

Defaults: `HOST=127.0.0.1`, `PORT=3001`, `DATA_DIR=data`. `DB_PATH` overrides the SQLite path. `ALLOWED_ORIGINS` optionally lists exact trusted browser origins; same-origin hosting needs no override. `WS_COMPRESSION=1` (exactly `1`) turns on WebSocket compression; it is off by default. `TRUSTED_CLIENT_IP_HEADER` names a request header that carries each player's real address, so rate limits apply per player behind a proxy that sets it (`cf-connecting-ip` behind Cloudflare Tunnel); leave it unset when players connect to the server directly. Databases and environment files are ignored by Git.

See [Deployment](docs/DEPLOYMENT.md) for containers, HTTPS, storage, settings and remote acceptance.

## Controls

| Action | Desktop | Phone |
| --- | --- | --- |
| Move | WASD or arrow keys | Left stick |
| Look | Mouse (click the game to capture it) | Drag the right side |
| Fire | Left click | Either Fire button. **Simple** firing also fires when your crosshair rests on a rival. |
| Aim down sights | Right click | Aim button |
| Sprint / dash | Shift; tap twice and hold to dash | Push the stick all the way forward to sprint, and again quickly to dash |
| Crouch / slide | C; press it while sprinting to slide | Crouch button; press it while sprinting to slide |
| Jump / vault | Space; jump into a low wall to climb over | Jump button |
| Reload | R | Reload button |
| Swap weapons | Q, mouse wheel, 1 or 2 | Swap button |
| Grenade | Hold G to cook, let go to throw | Hold the Grenade button, let go to throw |
| Knife | V | Knife button |
| Use a reward | 4 (Mortar Volley then asks you to pick a spot on the map; Esc cancels) | Tap the reward button when it appears |
| Scores | Hold Tab | Standings button (list icon) |
| Release mouse | Esc | Pause button |

Settings include look and aim sensitivity, field of view, **Invert vertical look**, hold or toggle for aim and crouch, how sprint works (hold, toggle or automatic), **Reduce camera motion** (on at first if your device is set to reduce motion), graphics, game volume, **Mobile firing** (Simple or Advanced) and optional **gyroscope aiming** with its own sensitivity. Gyroscope aiming asks for permission when you turn it on and needs HTTPS or localhost. Turn your phone sideways for the best view. Letting go of the stick stops you even while another finger keeps aiming.

All sound is made in the browser: guns that sound different indoors and outdoors, footsteps that change with the ground, reloads, hits, explosions, and a quiet background of wind and far-off gunfire. There is no music. Sound starts after your first tap or key press and comes back after interruptions. On supported iPhone browsers it follows the media volume. During a match, open **Pause → Settings → Test sound effects** to check it; **Game volume** at zero mutes everything.

## Your player and crew

Choose a nickname; no real name, email or age is needed. A private player key is made and saved in this browser. **Settings → Copy player key** lets you bring the same profile to another device with **Use existing player**. Keep the key private: anyone with it can use that player. If you clear the browser's storage without a copy of the key, you lose the profile.

Create or join a crew on **Leaderboard**, then select it when creating a ranked match. Everyone in a ranked match must belong to the crew. Crew invitations and match invitations are different things. Scores always come from the server.

Ratings start at 1,000 and move with results and how strong your opponents are. Five eligible matches place a player. Ranked games need two people and one minute of play; unfinished matches do not count. Only the first five results against the same opponent each day count. See [Architecture](docs/ARCHITECTURE.md) for the formula and limits.

## Project map

| Directory | Purpose |
| --- | --- |
| `src/components` | Menus, lobby, loadouts, leaderboard, HUD, touch controls |
| `src/game` | Three.js view, first-person camera and weapon, prediction, input, effects, audio |
| `src/lib` | Profile and settings, HTTP, WebSocket connection |
| `shared` | Wire contract, rules, weapon table, map, movement and hit-box physics |
| `server` | HTTP/WebSocket service, match engine, bots, SQLite |
| `tests` | Rules, physics, client, persistence, asset and multiplayer acceptance tests |
| `scripts/blender` | Reproducible Blender generators and validators |
| `art/source` | Editable sources, previews, build manifests |
| `public/models` | Soldier, weapon and town GLBs |
| `deploy` | Compose files and the production smoke check |

See the [Product brief](docs/PRODUCT_BRIEF.md), [Delivery plan](docs/DELIVERY_PLAN.md), [Visual direction](docs/DESIGN.md) and [Assets](docs/ASSETS.md). The overhaul's [design](docs/superpowers/specs/2026-10-30-first-person-combat-overhaul-design.md) and [plan](docs/superpowers/plans/2026-10-30-first-person-overhaul.md) explain why the game changed to first person.

Public lobby discovery is available; automatic matchmaking, purchases, voice or text chat and paid services are not. This public repository must never contain player keys, database contents or private invitations. The server checks every input and decides every hit, and it rewinds opponents up to 400 ms so that shots land where you saw the target. This protects a small invited community; it is not tournament-grade anti-cheat.
