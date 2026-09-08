# Kannon Arena

**Your crew. Your arena.** An original third-person, no-building browser shooter for a father, son, and invited friends to play on phones and desktops. The repository name remains `kannon-fps`; the approved camera is third-person.

## Current live build

- Private 2–8 player free-for-all rooms, host-controlled start, and rematches. Each player selects **Ready to play** after their prepared arena renders; everyone's readiness starts the full three-second countdown.
- Five-minute matches or first to 15 eliminations; three-second respawns.
- Fixed loadout: **1 AR · 2 Shotgun · 3 Healing ×2**.
- 100 health and 50 shield per life. Each heal restores up to 50 health after three seconds; damage or firing interrupts it.
- Two seconds of spawn protection, ending immediately on weapon fire.
- Keyboard/mouse and touch joystick, aiming, firing, jump, sprint, reload, and loadout controls.
- Solo practice against three moving AI rivals: Scout, Moxie, and Rook, with Relaxed, Balanced, or Challenging difficulty.
- Persistent profiles, private friend crews, monthly/all-time ratings, five-match placements, and match history.
- An original Blender model with a skinned armature and eight animation clips.

The [ready-before-countdown update](docs/ROUND_READINESS.md) is live at **https://kpop.8westventures.com** on Coastline. Implementation **[`979601a`](https://github.com/Seckcey/kannon-fps/commit/979601a88b7a5ea574fed817c1686bf327fe4acf)** merged through [PR #8](https://github.com/Seckcey/kannon-fps/pull/8) with [successful main CI](https://github.com/Seckcey/kannon-fps/actions/runs/34239819735). [/health](https://kpop.8westventures.com/health) identifies the running build, including later documentation closeouts. Cloudflare Tunnel uses **HTTP `127.0.0.1:14350`**. All 155 tests and asset/type/build checks passed, alongside [local desktop/touch acceptance](docs/verification/round-readiness-local.json), [isolated Linux acceptance](docs/verification/round-readiness-linux.json) and [public rendered acceptance](docs/verification/round-readiness-live.json). Real-device controls/performance and a two-household match remain; use the [family playtest guide](docs/FAMILY_PLAYTEST.md). The [release record](docs/RELEASE.md) separates these checks from historical art and performance evidence.

## Sunbreak V3 art and motion

The deployed [grounded Scout movement](docs/SCOUT_GROUNDED_GAIT.md) reduces near-floor sliding, smooths the repeating stride and stabilizes knee direction in the Blender Walk/Run clips. It preserves the model's polygon/rig budget and six other actions; residual foot roll and velocity differences remain documented. The preceding [scout form and movement upgrade](docs/SCOUT_MOTION_POLISH.md) fitted the shoulder armor and upper back, aligned gait with visible travel, corrected reload/heal prediction and gave practice rivals the existing stair/platform route. The fixed loadout, authoritative movement, collision and scoring are preserved.

The preceding [combat feedback release](docs/COMBAT_FEEDBACK.md) added per-pellet impacts, restrained shield/armor reactions and correctly placed respawn effects. Fixed-capacity render batches keep sustained firing bounded. That release preserved the V3 models; the subsequent scout geometry changes are recorded above.

The deployed [art-depth release](docs/ART_DEPTH.md) adds fuller coastal scenery, more defined architecture, an athletic weapon-ready stance and revised locomotion. It preserves the map collision, fixed loadout, movement speeds and match rules. [Public rendered practice](docs/verification/sunbreak-v3-live.json) verified release `884e24d` over HTTPS/WSS: all three rivals moved and fired, each matching V3 model downloaded once, and explicit exit produced no application errors. Source, controller, real-input and deployment checks remain separate forms of evidence.

The scout's geometry, rig, surfaces, weapon poses and six actions remain original. Walk and Run lower-body motion now derive from the CMU Graphics Lab's selected `09_01` capture, retargeted and timed in Blender. [Source provenance and separate data terms](art/source/motion/cmu-09/CMU-USAGE-NOTICE.md) and a [public credit notice](public/models/scout-motion-NOTICE.txt) accompany the model. The motion is not CC0 and must not be sold directly as motion data or an animation pack. `.gitattributes` preserves the exact publisher bytes used by the provenance hashes.

Movement animation follows actual speed, keeps the legs aligned with travel while preserving aim, and blends rapid input changes from the current pose. A grounded leg constraint corrects boot penetration during transitions without moving the actor or upper body. The implementation and its limits are described in [Architecture](docs/ARCHITECTURE.md) and [Assets](docs/ASSETS.md). The art remains stylized; these checks do not establish Fortnite-level quality or physical-phone performance.

## Run locally

Install **Node.js 24 or newer**, then run:

```powershell
npm ci
npm run dev
```

Open **http://localhost:5173**. Create a private match, share its room code with another player, and have the host start once at least two people have joined. Each player then selects **Ready to play** after their prepared arena appears. For solo play, choose **Practice first → choose difficulty → Create practice → Enter practice → Ready to play**. Balanced is the default. Model downloads finish before room entry and later rooms reuse their buffers; the countdown also waits for the current round to render and for deliberate control engagement.

Desktop readiness captures the mouse with that click; phones use the same button without firing or moving. Leaving the page, releasing the mouse, opening a menu or reconnecting while preparing requires readiness again. Preparation expires to the lobby after 45 seconds with a retry explanation. Once countdown begins, menus and disconnects do not pause the round. If an older game page is detected, refresh the players' pages before starting.

Practice rivals fight each other and you, use the same loadout and health, and can win or draw. Difficulty changes reactions, aim accuracy, and combat behavior. They use ground routes and the existing south stairs/platform, following visible opponents upward and returning through the stairs. They do not jump or perform general climbing. Rematches keep the chosen difficulty. Practice creates no bot profiles, saved match results, or crew-rating changes; your normal human profile remains persistent.

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
| Fire / heal | Left click | Fire / Heal button |
| Aim | Hold right click | Toggle Aim |
| Sprint | Shift | Toggle Sprint |
| Jump | Space | Jump button |
| Reload | R | Reload button |
| Select slot | 1, 2, 3 | Tap slot |
| Scores | Hold Tab | Roster / results screen |
| Release mouse | Escape | Pause button |

Settings include sensitivity, volume, graphics, and inverted vertical look. Landscape is recommended on phones.

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

No public matchmaking, purchases, voice/chat, or paid services have been added. This public repository must never contain player keys, database contents, or private invitations. Server validation protects a small invited community; it does not claim tournament-grade anti-cheat or latency compensation.
