# Architecture

React/Vite provide menus and HUD. The Three.js gameplay bundle loads when a match starts. Input, animation, and rendering run outside React; HUD updates follow snapshots. Local movement prediction corrects to authoritative state; opponents interpolate buffered snapshots.

One Node process serves static assets, HTTP API, and WebSocket matches. The simulation runs at 30 Hz, snapshots at 15 Hz. Rooms live in memory; profiles, crew membership, ratings, and history persist in SQLite with WAL and foreign keys. Restarting ends live rooms but preserves committed data. This is a single-process design for an invited community, not horizontal scaling.

## Rules and networking

`shared/protocol.ts` defines messages/rules, `shared/map.ts` solid obstacles/spawns, and `shared/physics.ts` movement, gravity, rays, and shoulder camera clipping. Clients send sequenced input intentions, never accepted positions, damage, or scores. The server validates bounds, sequence, cadence, ammo, reload, healing, line of sight, and protection. Brief action edges survive packet batching; stale input and disconnect clear actions.

Hits start at the shoulder view and are checked from the muzzle, preventing a visible camera from firing through cover in front of the weapon. Hit testing uses current server positions; there is no rewind/lag compensation yet. Movement time steps are capped against teleporting, so substantial event-loop stalls can slow movement while the wall-clock timer continues.

## Identity and privacy

A random opaque player key identifies a profile; only its hash is stored. The browser keeps the private key locally and authenticates HTTP via Bearer headers and WebSocket via its first message. Settings copies/restores it across devices. Nicknames do not establish identity. There is no email/password recovery, and sharing a key grants access to that player.

One WebSocket is active per player. A second replaces the first. Room invitations are random 80-bit codes with a two-hour life. Private crews use separate reusable random invitation capabilities; ranked participants and leaderboard viewers must be members. Member administration and invitation rotation are future work.

Controls include origin checks, payload/rate limits, room bounds, inactivity cleanup, slow-client backpressure, and static file confinement. Proxies must preserve Host/WebSocket upgrades and should apply their own client-address limits. The application ignores spoofable forwarded-address headers, so users behind a proxy share its application address bucket.

These are private-game controls, not comprehensive anti-cheat. A modified client can automate aim, inspect received world state, or create extra profiles. No public matchmaking or stranger discovery is present.

## Rankings

Crews have all-time and UTC-calendar-month stats. Ratings start at 1,000; five eligible matches place a player. Rating changes average pairwise Elo outcomes based on eliminations, K=32 and a 400-point expected-score scale. Tied eliminations draw the pairwise comparison. Rounded changes are stored; history shows all-time changes. A shared first-place draw counts as a match but not a win.

An eligible match needs at least one minute, two distinct crew members, and a complete connected roster. Abandoned/incomplete games do not count. Each opponent pair can contribute five ranked matches per UTC day in that crew; if any pair exceeds the cap, the entire game remains unranked.

Results, both periods, and opponent counters commit atomically. Unique match IDs prevent duplicate awards. Exclusions and save failures are reported rather than inventing successful results.

## Art

Blender exports the scout, armature, weapons, and eight hand-keyed clips. GLTFLoader and SkeletonUtils instantiate individual skinned players; the accent material distinguishes them. AnimationMixer blends locomotion and upper-body actions. Server state determines whether an action succeeds. The arena uses batched geometry aligned to shared collision and a generated limestone material. Automatic/Low graphics reduce rendering cost; actual phone performance still requires measurement.

## Primary references

- [Three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)
- [Responsive rendering](https://threejs.org/manual/en/responsive.html)
- [Node SQLite](https://nodejs.org/api/sqlite.html)
- [ws authentication/server examples](https://github.com/websockets/ws/blob/master/README.md)
