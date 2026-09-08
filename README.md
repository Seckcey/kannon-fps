# Kannon Arena

**Your crew. Your arena.** An original third-person, no-building browser shooter for a father, son, and invited friends to play on phones and desktops. The repository name remains `kannon-fps`; the approved camera is third-person.

## Current build

- Private 2–8 player free-for-all rooms, host-controlled start, and rematches.
- Five-minute matches or first to 15 eliminations; three-second respawns.
- Fixed loadout: **1 AR · 2 Shotgun · 3 Healing ×2**.
- 100 health and 50 shield per life. Each heal restores up to 50 health after three seconds; damage or firing interrupts it.
- Two seconds of spawn protection, ending immediately on weapon fire.
- Keyboard/mouse and touch joystick, aiming, firing, jump, sprint, reload, and loadout controls.
- Solo practice with three stationary training drones.
- Persistent profiles, private friend crews, monthly/all-time ratings, five-match placements, and match history.
- An original Blender model with a skinned armature and eight hand-authored animation clips in the live game.

This first playable build is deployed on Coastline at **https://kpop.8westventures.com**. Cloudflare Tunnel uses **HTTP `127.0.0.1:14350`**. Public HTTPS/WSS entry points are verified; real-device performance/controls acceptance and a two-household playtest remain. The Blender art uses human proportions with stylized armor; it is not photorealistic or motion-captured.

## Run locally

Install **Node.js 24 or newer**, then run:

```powershell
npm ci
npm run dev
```

Open **http://localhost:5173**. Create a private match, share its room code with another player, and start once at least two people have joined. Or choose **Practice first → Enter practice**.

For two players on one computer, use separate browser profiles or an incognito window. The same saved player may have only one active connection; another tab with that player replaces the earlier session.

To test a phone on the same local network, use the Network URL Vite prints. Network/firewall policy may restrict access. This does not expose the game to the public internet. Clipboard features require HTTPS or localhost; room codes can be entered manually on a LAN HTTP preview.

## Validate and run production

```powershell
npm run check
npm start
```

`check` runs simulation, storage, and HTTP/WebSocket acceptance tests, TypeScript checks, and the production build. `npm start` serves the built client and server together at **http://127.0.0.1:3001**. Rebuild after changing source before using production mode.

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
| `public/models` | Rigged game GLB |
| `deploy` | Compose and production smoke check |

See [Product brief](docs/PRODUCT_BRIEF.md), [Delivery plan](docs/DELIVERY_PLAN.md), [Visual direction](docs/DESIGN.md), and [Assets](docs/ASSETS.md).

No public matchmaking, purchases, voice/chat, or paid services have been added. This public repository must never contain player keys, database contents, or private invitations. Server validation protects a small invited community; it does not claim tournament-grade anti-cheat or latency compensation.
