# Delivery and acceptance

## First playable build

Implemented: approved third-person view, fixed loadout/healing, respawns/protection, server-owned multiplayer, private invitations/crews, persistent rankings/history, keyboard/mouse and touch interfaces, and a practice range. Blender source, a skinned glTF model, eight clips, and reproducible generation/validation scripts are included.

Validation includes TypeScript, simulation/storage regressions, HTTP/WebSocket acceptance, CI, and deployment definitions. Browser acceptance separately exercises rendered menus and gameplay. See the release record for exact results and limitations.

## Internet release gates

1. Select and approve hosting and any cost; no provider was provisioned by this implementation.
2. Deploy with HTTPS/WSS, persistent SQLite, backups, and restart policy.
3. Verify live build identity, assets, invitations, crew privacy, a completed ranked result, and rematch.
4. Test actual iPhone/Safari, Android/Chrome, and intended desktops. Record frame rates and controls; tune touch ergonomics with the players.
5. Play from two separate internet connections, including brief disconnection/recovery. Two tabs and emulated mobile sizes cannot prove this gate.

## After the first playtest

Tune weapon balance, healing, spawns, phone aim assistance, and map routes using observed gameplay. Improve animation/environment detail within the mobile budget. Add content after the core game loop is enjoyable and reliable.
