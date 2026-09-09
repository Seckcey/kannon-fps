# Kannon Arena

**Your crew. Your arena.** An original third-person, no-building browser shooter for a father, son, and invited friends to play on phones and desktops. The repository name remains `kannon-fps`; the approved camera is third-person.

## Current game

- Public or private free-for-all rooms for up to eight people, optional bots, host-controlled start, and rematches. Each player selects **Ready to play** after their prepared arena renders; everyone's readiness starts the full three-second countdown.
- Five-minute matches or first to 15 eliminations; three-second respawns.
- Fixed loadout: **1 AR · 2 Shotgun · 3 Healing ×2**.
- 100 health and 50 shield per life. Each heal restores up to 50 health after three seconds; damage or firing interrupts it.
- Two seconds of spawn protection, ending immediately on weapon fire.
- Keyboard/mouse and independent touch movement/aiming. Mobile Simple mode auto-fires at visible targets; Advanced supports holding and dragging Fire. Optional gyroscope aiming.
- **Kannon Town**, one compact neighborhood arena with two accessible houses, four stair routes, upstairs sightlines, rear yards, and central bus/truck cover.
- **Play against bots** for a solo match against Scout, Moxie, and Rook, with Relaxed, Balanced, or Challenging difficulty.
- **Available Games** lists public lobbies with open seats. Join without an invitation; private rooms stay hidden.
- Casual hosts can **Fill to 4 players with bots** and start alone. People replace bots as they join the lobby, up to eight human players.
- Persistent profiles, private friend crews, monthly/all-time ratings, five-match placements, and match history.
- An original Blender model with a skinned armature and eight animation clips.

Play at **https://kpop.8westventures.com**. [/health](https://kpop.8westventures.com/health) identifies the running commit and `worldVersion`; this checkout uses `kannon-town-v1`. Coastline remains behind Cloudflare Tunnel at **HTTP `127.0.0.1:14350`**. The [Kannon Town record](docs/KANNON_TOWN.md) covers the map, mobile changes and current verification; [Release verification](docs/RELEASE.md) retains prior releases. Refresh both devices after the update, then use the [family playtest guide](docs/FAMILY_PLAYTEST.md).

## Kannon Town and Scout

The [original Blender arena](docs/KANNON_TOWN.md) follows the compact two-house arrangement requested from Nuketown. It replaces Sunbreak as the single playable map. Both houses have usable interiors, upstairs rooms and rear balconies; real shared collision matches the rendered architecture and vehicles. The [town graphics release](docs/TOWN_GRAPHICS.md) adds detailed vehicles, siding, roof trim, paving, fences and foliage. The active environment is 7,884,316 bytes, 155,724 triangles and 33 material primitives.

The existing [grounded Scout movement](docs/SCOUT_GROUNDED_GAIT.md) and [combat feedback](docs/COMBAT_FEEDBACK.md) remain. Historical Sunbreak artwork and its release evidence are retained as source history.

The scout's geometry, rig, surfaces, weapon poses and six actions remain original. Walk and Run lower-body motion now derive from the CMU Graphics Lab's selected `09_01` capture, retargeted and timed in Blender. [Source provenance and separate data terms](art/source/motion/cmu-09/CMU-USAGE-NOTICE.md) and a [public credit notice](public/models/scout-motion-NOTICE.txt) accompany the model. The motion is not CC0 and must not be sold directly as motion data or an animation pack. `.gitattributes` preserves the exact publisher bytes used by the provenance hashes.

Movement animation follows actual speed, keeps the legs aligned with travel while preserving aim, and blends rapid input changes from the current pose. A grounded leg constraint corrects boot penetration during transitions without moving the actor or upper body. The implementation and its limits are described in [Architecture](docs/ARCHITECTURE.md) and [Assets](docs/ASSETS.md). The art remains stylized; these checks do not establish Fortnite-level quality or physical-phone performance.

## Run locally

Install **Node.js 24 or newer**, then run:

```powershell
npm ci
npm run dev
```

Open **http://localhost:5173**. Choose **Create match**, select **Public** or **Private**, and choose whether to **Fill to 4 players with bots**. Public lobbies appear in **Available Games**; private rooms use invitation links or codes. The host can start with one human plus AI rivals, or at least two humans with bots off. Each player then selects **Ready to play** after their prepared arena appears. For solo play, choose **Play against bots → choose difficulty → Create bot match → Enter bot match → Ready to play**. Balanced is the default. Model downloads finish before room entry and later rooms reuse their buffers; the countdown also waits for the current round to render and for deliberate control engagement.

Desktop readiness captures the mouse with that click; phones use the same button without firing or moving. Leaving the page, releasing the mouse, opening a menu or reconnecting while preparing requires readiness again. Preparation expires to the lobby after 45 seconds with a retry explanation. Once countdown begins, menus and disconnects do not pause the round. If an older game page is detected, refresh the players' pages before starting.

Practice rivals fight each other and you, use the same loadout and health, and can win or draw. Difficulty changes reactions, aim accuracy, and combat behavior. They use ground routes, both houses, all four stair routes and the open truck, following visible opponents upstairs and returning through the stairs. They do not jump or perform general climbing. Rematches keep the chosen difficulty. Solo and casual bot matches create no bot profiles, saved match results, or crew-rating changes; your normal human profile remains persistent. Casual bot filling is applied in the lobby and before rematches. Bot rosters stay fixed during play, and a match continues against existing bots if a friend leaves. Public games accept new players only while waiting for the host to start; full, preparing, playing, finished, expired, and empty disconnected rooms are excluded from Available Games.

For two players on one computer, use separate browser profiles or an incognito window. The same saved player may have only one active connection; another tab with that player replaces the earlier session.

To test a phone on the same local network, use the Network URL Vite prints. Network/firewall policy may restrict access. This does not expose the game to the public internet. Clipboard features require HTTPS or localhost; room codes can be entered manually on a LAN HTTP preview.

## Validate and run production

```powershell
npm run check
npm start
```

`check` runs client, simulation, storage, HTTP/WebSocket, and asset checks, TypeScript checks, and the production build. `npm start` serves the built client and server together at **http://127.0.0.1:3001**. Rebuild after changing source before using production mode.

Defaults: `HOST=127.0.0.1`, `PORT=3001`, `DATA_DIR=data`. `DB_PATH` overrides the SQLite path. `ALLOWED_ORIGINS` optionally lists exact trusted browser origins; same-origin hosting needs no override. Databases and environment files are ignored by Git.

See [Deployment](docs/DEPLOYMENT.md) for containers, HTTPS, persistent storage, and remote acceptance.

## Controls

| Action | Desktop | Phone |
| --- | --- | --- |
| Move | WASD / arrow keys | Left joystick |
| Look | Mouse; click to capture | Drag right side |
| Fire / heal | Left click | Simple: aim at a rival to auto-fire. Advanced: hold/drag Fire. Tap Heal in slot 3. |
| Aim | Hold right click | Toggle Aim; Advanced Fire aims the AR and hip-fires the shotgun |
| Sprint | Shift | Toggle Sprint |
| Jump | Space | Jump button |
| Reload | R | Reload button |
| Select slot | 1, 2, 3 | Tap slot |
| Scores | Hold Tab | Roster / results screen |
| Release mouse | Escape | Pause button |

Settings include sensitivity, volume, graphics, inverted vertical look, **Mobile firing**, and optional **gyroscope aiming** with its own sensitivity. Gyroscope access requires a deliberate permission gesture and HTTPS/localhost on supported devices. Landscape is recommended on phones. Releasing the joystick stops movement even while a second finger continues aiming.

## Your player and crew

Choose a nickname; no real name, email, or age is required. A private player key is generated and saved in this browser. **Settings → Copy player key** lets you restore the same profile on another device using **Use existing player**. Keep the key private: anyone with it can use that player. Clearing browser storage without backing it up loses profile access.

Create or join a crew on **Leaderboard**, then select it when creating a ranked match. Every ranked participant must belong to the crew. Crew and match invitations serve different purposes. Scores always come from the server.

Ratings start at 1,000 and reflect results and opponent strength. Five eligible matches place a player. Ranked games need two people and one minute of play; incomplete matches are excluded. A daily opponent-pair cap limits farming. See [Architecture](docs/ARCHITECTURE.md) for the formula and limits.

## Project map

| Directory | Purpose |
| --- | --- |
| `src/components` | Menus, lobby, leaderboard, HUD, touch controls |
| `src/game` | Three.js, Blender animations, input, audio |
| `src/lib` | Profile/settings, HTTP, WebSocket connection |
| `shared` | Wire contract, rules, map, collision/camera math |
| `server` | HTTP/WebSocket service, simulation, SQLite |
| `tests` | Simulation, persistence and multiplayer acceptance |
| `scripts/blender` | Reproducible Blender generator and validator |
| `art/source` | Editable `.blend`, previews, export manifest |
| `public/models` | Rigged character and arena GLBs |
| `deploy` | Compose and production smoke check |

See [Product brief](docs/PRODUCT_BRIEF.md), [Delivery plan](docs/DELIVERY_PLAN.md), [Visual direction](docs/DESIGN.md), and [Assets](docs/ASSETS.md).

Public lobby discovery is available; automatic matchmaking, purchases, voice/chat, and paid services have not been added. This public repository must never contain player keys, database contents, or private invitations. Server validation protects a small invited community; it does not claim tournament-grade anti-cheat or latency compensation.
