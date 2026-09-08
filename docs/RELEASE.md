# Release verification

## Sunbreak visual and practice upgrade candidate

This candidate replaces the code-drawn courtyard with an original Blender observatory environment and improves the armored scout, weapon handling and animation. Three active practice rivals offer Relaxed, Balanced and Challenging difficulty; practice results never affect crew standings. Room entry retains validated model bytes before admission, supports cancellation and retries, and guards against stale identity/nickname/crew responses. The authoritative shoulder camera and client view remain shared.

The renderer adds coherent sky/reflections, sunlight and contact shading, sea motion, foliage motion and adaptive canvas resolution with native HUD controls. It avoids drawing hidden water, reuses scene depth for contact shading, limits data-map filtering and uses a compact diffuse sky probe on rough surfaces. The optional desktop effect is a separate download; unsupported floating-point targets use a conventional atmosphere path.

Current candidate evidence, before GitHub/Coastline release closeout:

- The full local check passed 71 tests, both Blender export validators, TypeScript and the production build. Production dependency audit reported zero known vulnerabilities.
- Final scout: 2,658,568 bytes, 22,654 vertices, 20,868 triangles, 18 bones and eight clips. Final environment: 6,460,940 bytes, 116,740 vertices, 66,272 triangles, 15 material batches; SHA-256 `f4d6ef377cebf088596af88720517e67f913b6dae9c01880c35bd8069fb6530d`. Collision/visual probes cover all 17 reference volumes, 102 visible faces, 108 outward winding samples and four travel lanes.
- Real browser entry checks passed canceled and failed downloads, cached retry, all three difficulties, no second model fetch after admission, restored identity during warmup, nickname editing during canceled profile creation and rejection of late crew responses. Intentional HTTP 503 responses are distinguished from application errors.
- Real two-client desktop/touch combat checks passed movement, view aiming, both weapons, reload, jump, mutual damage and timed healing. Portrait/landscape practice passed active AI, difficulty selection, rotation, quit and re-entry. Real offline/online recovery restored the private room, preserved authoritative state and required fresh gestures before movement/fire resumed.
- Edge/Playwright full-page capture was isolated as changing emulated touch capabilities; ordinary viewport captures preserve the same capabilities and pass rotation. Browser tooling is a fallback because the Browser plugin is unavailable in this session. Emulation does not establish physical-phone acceptance.
- An independent all-difficulty bot sweep completed 18 seeded rounds, 92,885 simulated ticks and 8,594 shots without non-finite state, solid penetration, prolonged living stalls or unfinished rounds. This is logical simulation, not a production capacity measurement.

The final isolated rendering run used installed Edge/ANGLE on AMD Radeon integrated graphics at a 1672×941 CSS viewport, with eight animated characters in a fixed scene. The last eight frame-rate samples were 31–38 FPS on High (1086×611 internal pixels, 144 draws, contact shading), 49–57 on Automatic (959×540, 138 draws, contact shading disabled), and 51–57 on Low (1182×665, 79 draws). These are bounded rendering samples, not a multiplayer latency or physical-phone guarantee. An intentionally disabled HDR capability rendered the 852×393 touch viewport successfully at 60 FPS after startup on the same desktop GPU. Raw measurements are retained in [the rendering report](verification/sunbreak-v2-render.json).

There were no application errors in the final render or actual practice entry. Edge reported a one-time shader constant precision warning during sky baking; the forced unsupported-HDR test also emitted its expected capability warning. No runtime program errors were present. Rapid UI exits and recovery did not reproduce an earlier invalid-program driver warning. Direct construction/disposal at 0, 4, 16 and 80 ms did expose a pending sky-probe cleanup exception; guarded target disposal before renderer teardown repaired it and all four timings then passed without errors or readbacks after context loss. Contact-shader material disposal and the shared camera floor clamp were also independently reviewed and corrected.

Actual gameplay is shown in [the desktop practice capture](art/sunbreak-v2-gameplay-desktop.png). Direct comparison against the concept confirms readable armor, textured stone, cast shadows, native HUD and active rivals; the block-like buildings, sparse foliage and simpler horizon still fall short of the concept's environmental detail. No claim of Fortnite-level visual quality follows from these checks.

Linux candidate testing and deployment evidence will be recorded before marking this candidate live. The historical sections below describe their own earlier releases and should not be read as acceptance of a later art build.

## Build scope

This release implements the agreed private third-person phone/desktop game, fixed AR/shotgun/healing loadout, respawns, five-minute/15-elimination matches, private crew standings/history, and original Blender character/weapon animation. It is a playable first release, not a claim of finished AAA art, real-device acceptance, or tournament-grade networking.

## Mobile recovery and simultaneous combat

This release repairs stale touch input after backgrounding, silent connection loss, leaving during reconnect, and missing host/results state when players return. A healthy connection survives a brief background transition; an unresponsive one reconnects automatically. Touch movement, aim, sprint, and queued actions release when focus or pointer capture is lost, and a fresh gesture resumes play. Background time no longer lowers graphics quality. The change is tracked in [PR #2](https://github.com/Seckcey/kannon-fps/pull/2).

The server restores host control when all players disconnect and somebody returns, replays the original completed result without writing standings again, and resolves shots from the same simulation tick together. Mutual eliminations and simultaneous score-limit draws no longer depend on player join order.

- `npm run check` passes all 53 client, simulation, storage, HTTP, and WebSocket tests, TypeScript, Blender validation, and the production build.
- The nine-group desktop/touch browser acceptance flow passes again against the production build at 1536×1024, 852×393, and 390×844 with no application errors or warnings.
- A focused Edge browser test uses real offline/online transitions while a touch joystick is held and aim/sprint are enabled. The same room recovers automatically, stale controls stay released, a fresh touch fires, leaving stays at the menu, and the next practice creates a new room. No browser errors or warnings occurred.
- Multi-touch ownership, lost pointer capture, cancelled taps, and two simulated 15-second background suspensions were checked in Chrome. Graphics quality and shadows remained stable.
- The Linux candidate `055c8f67e969b5cbd34bf3956b10f3b8256b6f61` passed a real 60-second eight-player transport run on Coastline using Node 24.20.0 with the app and load generator sharing one CPU and 512 MiB. All eight players moved, fired both weapons, and reloaded: 14,410 input frames, 1,295 server-confirmed AR shots, and 159 shotgun shots. Ninth-player rejection preserved that player's previous room; a deliberate disconnect restored one identity, pose, health, ammunition, score, and fresh input sequence. There were no unexpected disconnects or errors.
- Continuous Linux peers received 15.05 snapshots/sec and 30.10 simulation ticks/sec. The worst peer's snapshot gap was 67.61 ms at p95 and 69.20 ms maximum; every consecutive snapshot advanced two ticks. Latest acknowledged input age was at most 34.34 ms p95, and the sampled profile request took 4.88 ms. This was loopback traffic in a disposable container with temporary memory-backed data and no published port, not a phone rendering, wide-area latency, or production capacity guarantee.
- Local Windows transport testing passed the same functional eight-player checks but measured about 24 simulation ticks/sec and 12 snapshots/sec; a separate two-player baseline was similarly affected. The Linux candidate met the intended cadence. Host scheduling must be measured rather than inferred from configured timer intervals.

## First playable local verification

- 29 simulation/storage/HTTP/WebSocket regressions pass, including action taps surviving input batching, damage/cover validation, healing, respawns, host transfer, privacy, draw handling, and atomic/idempotent ratings.
- TypeScript and the production build pass; production dependencies report no known npm audit vulnerabilities at verification time.
- Blender GLB structural/budget validation passes: 24,026 exported vertices, 21,056 triangles, 18 bones, eight clips, six embedded textures. Final model SHA-256: `f48146732889891bc1299b6267cfd2b74d40c3ba1c53b5976a852607f67ab2c9`.
- Playwright Edge rendered tests pass at 1536×1024 desktop, 852×393 touch landscape, and 390×844 touch portrait with no application console errors/warnings. The in-app browser acquisition timed out, so Playwright used the installed Edge browser.
- Actual UI path verified: menu → private room → two players → host start/countdown → desktop and touch gameplay → leave/incomplete results → crew creation/standings → practice range.
- Real pointer lock, WASD movement, fire, reload, jump, slots, touch joystick, touch fire/reload, Escape, and quit/re-enter canvas disposal were exercised. Quick-tap loss, spawn-slot reset, and explicit pointer unlock were repaired during testing.
- Two isolated browser sessions completed a real 300-second ranked draw. Both players received exactly one match, zero wins, unchanged 1,000 rating, and one history entry in monthly/all-time standings. Rematch reset the timer, health, shield, slot, ammunition, and healing; leaving it added no result. No browser or asset errors occurred.

## Visual comparison

Compared generated lobby/gameplay references with rendered screenshots using direct image inspection. Inspected copy, two-line title, header/navigation, navy/lime/seafoam palette, type hierarchy, illustrated character framing, action hierarchy, loadout arrangement, mobile overflow, and HUD placement.

The desktop title initially wrapped into four lines; its sizing and explicit line spans were corrected. The real menu keeps the reference's required copy, control order, and visual direction. Icons are native SVG and controls are real HTML. The standalone illustration differs in pose framing from the concept. Gameplay uses free-look Blender models and lighter real-time geometry rather than the illustrated environment; those detail differences remain intentional and are not described as pixel-identical final art.

Hosted screenshots: [loaded lobby](art/verified-lobby.png), [desktop gameplay](art/verified-gameplay-desktop.png), and [emulated touch landscape](art/verified-gameplay-touch.png). The lobby screenshot waits for the illustration request to finish. The heading was also corrected to refresh its crew member count and use singular/plural wording; focused two-browser verification passed for one member, two members after joining, and monthly standings.

## Coastline deployment

The user authorized Coastline hosting. Read-only preflight confirmed the expected Hyper-V Linux VM, available capacity, a writable `/srv/8west/apps`, no existing Kannon checkout, and unused port 14350. The dedicated game now runs there. Cloudflared runs in the host network, so the verified origin is `http://127.0.0.1:14350` for `kpop.8westventures.com`.

- Implementation [PR #1](https://github.com/Seckcey/kannon-fps/pull/1) merged as `4c6c4e0e95a0f9a3daecc021e5ea6ca199b82999`; [main CI](https://github.com/Seckcey/kannon-fps/actions/runs/34186643146) passed, including a real Docker image and production smoke run. The release also includes the subsequent crew member-count display correction and these operational notes.
- Linux Node 24 container build and production HTTP/WebSocket smoke passed. `/health` reports the deployed source revision; the hosted Blender GLB SHA-256 matches the verified export above. The configured public HTTPS Origin passed the WebSocket origin check; anonymous room creation was rejected.
- The full desktop/touch UI acceptance flow passed against the actual Coastline container through SSH forwarding, with nine check groups and no browser errors/warnings. Public HTTPS, the built client, and WSS subsequently passed through `https://kpop.8westventures.com` after the user configured Cloudflare. Two temporary QA profiles and their private test crew are isolated from future family crews; no ranked scores were awarded on this hosted run.
- Container `kannon-arena-arena-1` is healthy, runs as `node`, binds only `127.0.0.1:14350`, and uses its own `kannon-arena_arena-data` volume and network. Read-only root, dropped capabilities, no-new-privileges, 512 MiB/one CPU/128 PID limits, and rotating logs were inspected.
- All 65 existing containers retained identical IDs, states, and restart counts after deployment. Their sorted identity/state/restart SHA-256 remained `a421ed263d2c48117954d226f2db42d4bfa863e0b2b2e8df324f15c5fc688e4a`. Protected HTTP checks matched preflight, with no newly unhealthy services. Intentionally stopped migration sources remained stopped.

See [deployment instructions](DEPLOYMENT.md) for the exact Cloudflare fields, scoped update commands, and backup/rollback procedures. Recurring off-host backups are not configured.

## Remaining acceptance

Physical iPhone/Android performance, phone aim balancing, adverse wide-area latency, and a two-household family playtest remain unverified. Emulated touch dimensions and same-computer clients do not prove them.
