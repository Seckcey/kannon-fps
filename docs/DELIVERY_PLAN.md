# Delivery and acceptance

## First playable build

The deployed baseline is revision `200eeaf`: approved third-person view, fixed loadout/healing, respawns/protection, server-owned multiplayer, private invitations/crews, persistent rankings/history, keyboard/mouse and touch interfaces, and an initial solo practice mode. Blender source, a skinned glTF model, eight clips, and reproducible generation/validation scripts are included.

Validation includes TypeScript, simulation/storage regressions, HTTP/WebSocket acceptance, CI, and deployment definitions. Browser acceptance separately exercises rendered menus and gameplay. See the release record for exact results and limitations.

## Visual and practice upgrade — not deployed

The development upgrade adds three active practice rivals with Relaxed, Balanced, and Challenging difficulty. The entry flow is **Practice first → choose difficulty → Create practice → Enter practice**. Bots use the existing loadout/combat/respawn rules, can win or draw, and keep difficulty across rematches. They follow ground routes around cover and platforms; jumping and climbing remain outside this slice. Practice never writes bot profiles or ranked results.

Room entry prepares retained GLB bytes before admission, then reuses those bytes for rendering. Failed downloads can retry without refetching successful assets. Replacing the player or leaving cancels stale entry work, so a delayed download cannot enter a room as a previous identity.

Focused automated checks cover AI perception, navigation and corner recovery, reaction/aim differences, weapons/healing, match outcomes, rematches, disconnect suspension, invalid settings, persistent-data isolation, asset sharing, timeout/retry, and damaged GLB responses. A seeded match simulation checks movement/collider safety and bounded server work; it is not a physical-phone FPS measurement. Rendered integration, release validation, and deployment must be recorded separately before this upgrade is called live.

## Internet release gates

The completed gates below refer to the deployed baseline, not the unreleased overhaul.

1. **Complete:** user approved Coastline; dedicated container, persistent SQLite volume, restart policy, resource limits, and loopback origin `127.0.0.1:14350` are running. Backup/recovery procedures are documented; recurring off-host backups are not configured.
2. **Complete at the origin:** deployed revision, assets, HTTP/WebSocket entry points, and two-player desktop/touch gameplay verified through SSH forwarding. Local rendered acceptance completed a real five-minute ranked match, checked saved standings/history, and started a clean rematch.
3. **Complete public entry points:** `kpop.8westventures.com` routes through the existing Cloudflare Tunnel to HTTP `127.0.0.1:14350`. Public HTTPS, the built client, and secure WebSocket transport pass smoke checks. Verify actual device play and invitations across separate connections below.
4. **Pending real devices:** test actual iPhone/Safari, Android/Chrome, and intended desktops. Record frame rates and controls; tune touch ergonomics with the players.
5. **Pending family playtest:** play from two separate internet connections, including brief disconnection/recovery. Two tabs and emulated mobile sizes cannot prove this gate.

## After the first playtest

The mobile/recovery pass fixes interrupted touch gestures, stale controls after backgrounding, unwanted graphics downgrades on resume, stalled connection retries, host recovery, finished-result replay, and simultaneous-hit fairness. These changes do not establish physical-phone or wide-area play acceptance.

Tune weapon balance, healing, spawns, phone aim assistance, and map routes using observed gameplay. Improve animation/environment detail within the mobile budget. Add content after the core game loop is enjoyable and reliable.
