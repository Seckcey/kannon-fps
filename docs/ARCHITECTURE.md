# Architecture

React/Vite provide menus and HUD. The Three.js gameplay bundle and versioned model bytes warm when the user creates or joins a room, before opening the room connection. Input, animation, and rendering run outside React; HUD updates follow snapshots. Local movement prediction corrects to authoritative state; opponents interpolate buffered snapshots.

This document describes the live Sunbreak visual and active-practice implementation, introduced in verified release [`bd58bd3`](https://github.com/Seckcey/kannon-fps/commit/bd58bd35723f8f7b9bb10b58914784b26909533e) through [PR #3](https://github.com/Seckcey/kannon-fps/pull/3). The [/health](https://kpop.8westventures.com/health) response is the canonical current build identity; later documentation closeouts can advance its revision. See the [release record](RELEASE.md) for candidate, CI, deployment, and acceptance evidence. Physical-phone performance and two-household play remain separate acceptance gates.

One Node process serves static assets, HTTP API, and WebSocket matches. The simulation targets 30 Hz, snapshots 15 Hz; actual cadence depends on host scheduling and load. Rooms live in memory; profiles, crew membership, ratings, and history persist in SQLite with WAL and foreign keys. Restarting ends live rooms but preserves committed data. This is a single-process design for an invited community, not horizontal scaling.

## Rules and networking

`shared/protocol.ts` defines messages/rules, `shared/map.ts` solid obstacles/spawns, and `shared/physics.ts` movement, gravity, rays, and shoulder camera clipping. Clients send sequenced input intentions, never accepted positions, damage, or scores. The server validates bounds, sequence, cadence, ammo, reload, healing, line of sight, and protection. Brief action edges survive packet batching; stale input and disconnect clear actions.

Hits start at the shoulder view and are checked from the muzzle, preventing a visible camera from firing through cover in front of the weapon. Hit testing uses current server positions; there is no rewind/lag compensation yet. Movement time steps are capped against teleporting, so substantial event-loop stalls can slow movement while the wall-clock timer continues.

Within one simulation tick, all players finish movement and valid shots are accepted before any damage resolves. Mutual lethal hits can trade eliminations, and simultaneous score-limit hits can draw. If multiple attackers damage the same victim in that tick, the largest contribution receives elimination credit; equal contributions use a deterministic per-tick tie-break independent of join order. Weapon statistics remain unchanged.

The browser detects eight seconds of silence while visible and retires stalled sockets without waiting for TCP closure. Coming back online retries automatically. Foreground return probes a quiet connection for up to 1.5 seconds before replacement, allowing a healthy connection to retain the host role. Authentication/session-replacement closures never trigger automatic takeover. Explicitly leaving retires the socket so delayed room messages cannot reopen the match.

Disconnected players have a 30-second recovery window. Movement, actions, and published velocities clear on disconnect. The first connected player becomes host when the former host is absent, including when an entire room returns from a connection loss. Rejoining a finished room replays its cached result explanation without writing ratings again; a rematch clears that cached result.

## Practice opponents

`server/bots.ts` generates ordinary input frames for three clearly labeled rivals. The engine applies the same movement, collision, ammo, weapon cadence, healing, protection, respawn, and simultaneous-damage rules to humans and bots. Practice winners include bots, including time-limit or score-limit ties. Friends matches never add AI players.

The optional `practiceDifficulty` create/room field accepts `easy`, `normal`, or `hard`; omitted practice difficulty defaults to `normal`. The UI labels these Relaxed, Balanced, and Challenging. Difficulty adjusts reaction delay, turning, aim error, perception range, burst/rest timing, and engagement distance. It does not grant extra health or damage. Invalid values are rejected before leaving the current room; valid difficulty settings have no effect on human-only matches.

Perception samples visible opponents at 10 Hz with field-of-view and map-occlusion checks. Lost sight retains a short last-seen position instead of tracking movement behind walls. Navigation uses a bounded visibility graph derived from shared collision boxes with player clearance, cached across rooms. Routes go around platforms and steps on the ground; climbing and jumping are not implemented. Bots can aim at visible elevated players. Corner recovery walks out of navigation padding without teleporting through physical geometry.

Bots reload and heal through the existing engine timers. Their actions suspend when no human remains connected, and recovery starts a fresh reaction delay; the match clock continues. Each rematch resets bot decision state and uses a fresh seed. An internal `EngineOptions.practiceSeed` supports reproducible simulations and is never accepted over HTTP or WebSocket.

Practice is always unranked, including a forged create request combining `practice: true` with `ranked: true`. Bot identities, decisions, and practice results stay in room memory. No bot profile, rating, opponent-pair counter, or match-history row is written. Human profile creation/restoration follows the normal persistent identity flow.

## Room entry and asset lifetime

`src/game/assets.ts` retains one shared `Promise<ArrayBuffer>` for each of the two versioned model URLs. Warmup and the character/environment parsers consume these same bytes, avoiding a second model request after admission. Header length, GLB version, chunk boundaries, and JSON asset version are checked before caching. GLTF parsing and GPU initialization still happen when the view starts; loading/error states keep gameplay input paused.

Each download owns a 60-second abort deadline, cleared when it settles. Failure evicts only that model's promise; a retry reloads its HTTP-cache entry so a corrupt cached response cannot poison later attempts. Successful model bytes remain for the page lifetime and later rooms reuse them. Callers read the buffers without mutation or transfer; canceling one room-entry attempt does not abort a shared download needed by another consumer. The cache accepts only the two configured asset URLs.

Room-entry operations carry a generation counter. Canceling entry, leaving, replacing the player, or unmounting invalidates pending work and acknowledgement timers. The captured player token is checked after preparation and again after connecting; a delayed profile-save response cannot replace a newer restored identity. Navigation and creation settings are disabled while preparing, and synchronous busy checks suppress repeated submissions. Closing the entry dialog remains available to cancel; it retires any pending room connection so late room messages cannot pull the player back in. Asset warmup may complete into its bounded cache after cancellation, but the canceled operation cannot create or join a room.

An in-flight profile creation can finish after entry is canceled. A newer nickname edit stays visible, and a subsequent entry waits for that profile, saves the new nickname on the same identity, then connects. Restoring a player invalidates older profile work, clears the previous crew list and leaderboard selection, and rejects delayed crew responses belonging to an earlier request or identity.

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

Blender exports the scout, armature, weapons, and eight hand-keyed clips. GLTFLoader and SkeletonUtils instantiate individual skinned players; the accent material distinguishes them. AnimationMixer blends locomotion and upper-body actions. Server state determines whether an action succeeds. Published `aiming` state clears with stale input, disconnect, death, and respawn. Animation helpers use the same supporting-surface calculation as physics for grounded poses and shadow placement. The Blender-authored arena stays aligned to shared solid collision. Automatic/Low graphics reduce rendering cost; actual phone performance still requires measurement.

Atmospheric sky and filtered reflections are baked once per view. A small asynchronously read sky probe supplies diffuse light to rough stone and foliage, avoiding repeated filtered-cubemap sampling; metal, water and armor retain full reflections. Floating-point capability gates this path and optional desktop contact shading. Missing support or a rejected probe falls back to ordinary lighting. Probe targets release before renderer teardown, and late readback completion cannot dispose cleared WebGL resources again. The environment and GPU lighting rebuild on re-entry even though model bytes remain cached.

Touch controls retain ownership of individual fingers, release interrupted captures, and reset joystick/Aim/Sprint displays when input is cancelled. Background or paused callbacks cannot reactivate movement; players resume with a fresh gesture. Background suspension resets frame timing rather than counting as sustained poor GPU performance.

## Primary references

- [Three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)
- [Responsive rendering](https://threejs.org/manual/en/responsive.html)
- [Node SQLite](https://nodejs.org/api/sqlite.html)
- [ws authentication/server examples](https://github.com/websockets/ws/blob/master/README.md)
