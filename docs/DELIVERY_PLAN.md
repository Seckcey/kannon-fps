# Delivery and acceptance

## First playable build

Implemented: approved third-person view, fixed loadout/healing, respawns/protection, server-owned multiplayer, private invitations/crews, persistent rankings/history, keyboard/mouse and touch interfaces, and a practice range. Blender source, a skinned glTF model, eight clips, and reproducible generation/validation scripts are included.

Validation includes TypeScript, simulation/storage regressions, HTTP/WebSocket acceptance, CI, and deployment definitions. Browser acceptance separately exercises rendered menus and gameplay. See the release record for exact results and limitations.

## Internet release gates

1. **Complete:** user approved Coastline; dedicated container, persistent SQLite volume, restart policy, resource limits, and loopback origin `127.0.0.1:14350` are running. Backup/recovery procedures are documented; recurring off-host backups are not configured.
2. **Complete at the origin:** deployed revision, assets, HTTP/WebSocket entry points, and two-player desktop/touch gameplay verified through SSH forwarding. Local rendered acceptance completed a real five-minute ranked match, checked saved standings/history, and started a clean rematch.
3. **Complete public entry points:** `kpop.8westventures.com` routes through the existing Cloudflare Tunnel to HTTP `127.0.0.1:14350`. Public HTTPS, the built client, and secure WebSocket transport pass smoke checks. Verify actual device play and invitations across separate connections below.
4. **Pending real devices:** test actual iPhone/Safari, Android/Chrome, and intended desktops. Record frame rates and controls; tune touch ergonomics with the players.
5. **Pending family playtest:** play from two separate internet connections, including brief disconnection/recovery. Two tabs and emulated mobile sizes cannot prove this gate.

## After the first playtest

The mobile/recovery pass fixes interrupted touch gestures, stale controls after backgrounding, unwanted graphics downgrades on resume, stalled connection retries, host recovery, finished-result replay, and simultaneous-hit fairness. These changes do not establish physical-phone or wide-area play acceptance.

Tune weapon balance, healing, spawns, phone aim assistance, and map routes using observed gameplay. Improve animation/environment detail within the mobile budget. Add content after the core game loop is enjoyable and reliable.
