# First playable release verification

## Build scope

This release implements the agreed private third-person phone/desktop game, fixed AR/shotgun/healing loadout, respawns, five-minute/15-elimination matches, private crew standings/history, and original Blender character/weapon animation. It is a playable first release, not a claim of finished AAA art, real-device acceptance, or tournament-grade networking.

## Local verification

- 29 simulation/storage/HTTP/WebSocket regressions pass, including action taps surviving input batching, damage/cover validation, healing, respawns, host transfer, privacy, draw handling, and atomic/idempotent ratings.
- TypeScript and the production build pass; production dependencies report no known npm audit vulnerabilities at verification time.
- Blender GLB structural/budget validation passes: 24,026 exported vertices, 21,056 triangles, 18 bones, eight clips, six embedded textures. Final model SHA-256: `f48146732889891bc1299b6267cfd2b74d40c3ba1c53b5976a852607f67ab2c9`.
- Playwright Edge rendered tests pass at 1536×1024 desktop, 852×393 touch landscape, and 390×844 touch portrait with no application console errors/warnings. The in-app browser acquisition timed out, so Playwright used the installed Edge browser.
- Actual UI path verified: menu → private room → two players → host start/countdown → desktop and touch gameplay → leave/incomplete results → crew creation/standings → practice range.
- Real pointer lock, WASD movement, fire, reload, jump, slots, touch joystick, touch fire/reload, Escape, and quit/re-enter canvas disposal were exercised. Quick-tap loss, spawn-slot reset, and explicit pointer unlock were repaired during testing.

## Visual comparison

Compared generated lobby/gameplay references with rendered screenshots using direct image inspection. Inspected copy, two-line title, header/navigation, navy/lime/seafoam palette, type hierarchy, illustrated character framing, action hierarchy, loadout arrangement, mobile overflow, and HUD placement.

The desktop title initially wrapped into four lines; its sizing and explicit line spans were corrected. The real menu keeps the reference's required copy, control order, and visual direction. Icons are native SVG and controls are real HTML. The standalone illustration differs in pose framing from the concept. Gameplay uses free-look Blender models and lighter real-time geometry rather than the illustrated environment; those detail differences remain intentional and are not described as pixel-identical final art.

## Deployment target

The user authorized Coastline hosting. Read-only preflight confirmed the expected Hyper-V Linux VM, available capacity, a writable `/srv/8west/apps`, no existing Kannon checkout, and unused port 14350. Cloudflared runs in the host network, so the intended origin is `http://127.0.0.1:14350` for `kpop.8westventures.com`.

Deploy only a dedicated `kannon-arena` Compose project and data volume. Existing applications and stopped migration sources are protected. Live commit, health, CI, container and postflight results are recorded after deployment.

## Remaining acceptance

Physical iPhone/Android performance, phone aim balancing, adverse wide-area latency, and a two-household family playtest remain unverified. Emulated touch dimensions and same-computer clients do not prove them. Cloudflare routing must be pointed to the verified origin before public HTTPS/WSS acceptance.
