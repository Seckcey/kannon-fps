# Kannon Town vehicle graphics experiment

Historical local experiment on `codex/vehicle-graphics-test`, based on `29e8014911f4822e8736c1307736dcf8d9c8cca9`. The user subsequently approved the vehicles and authorized a broader graphics release and deployment. See [the current release](../../docs/TOWN_GRAPHICS.md). Measurements below describe the original isolated experiment and its lighting.

Only the school bus, south car and north car are replaced. The original `kannon-town.blend`, `environment.glb`, town generator, cargo truck, map collision, input, cameras, weapons, networking and ranking implementation remain intact. The separate review page uses the existing `GameView`, `InputController`, `TouchControls` and shared movement/collision functions. Its walk-around mode is a movement sandbox; the **Full practice match** link enters ordinary local gameplay with the selected vehicle version.

## Open the review

From this worktree, with the existing npm dependencies available:

```powershell
npm run vehicle-test
```

Open `http://127.0.0.1:5183/vehicle-test.html`. The launcher uses Vite port 5183, game server port 3013 and this worktree's `data/vehicle-review.sqlite`. It does not use the main checkout's running servers or database. If a test server is already running on those ports, use that instance or stop only the identified test processes before restarting.

The review has eight repeatable views, including two closer wheel/panel inspections, Before/After switching, normal gameplay distances, walk-around and High/Auto/Low modes. Quality is locked in this comparison so automatic resolution changes cannot mask asset cost. Ordinary practice retains its original adaptive quality. The `?original=1` review parameter renders the unchanged, unsplit original town for measuring the overhead introduced by comparison extraction.

Both versions receive the same sunlight, sky, exposure, renderer and shadow settings. Close-ups hide the player; third-person views preserve the original gameplay camera and player. Switching models does not move the camera. The review disables variant/view/graphics changes while measuring and discards samples when visibility, window size, orientation, camera or graphics change.

## Editable sources and regeneration

- `vehicle-test.blend`: three editable, world-positioned vehicle parents, material batches, named semantic vertex groups and packed source maps. Preview light/camera names start with `BlenderPreview_` and are excluded from glTF.
- `vehicle-materials/`: original source albedo, packed ORM and micro-normal maps. These are embedded in the GLB; browsers do not download the source directory.
- `../../scripts/blender/generate_vehicles.py`: complete deterministic authoring and export program.
- `vehicle-test-manifest.json`: final export dimensions, version, hashes, triangle counts and provenance.
- `vehicle-test-baseline.json`: exact original-geometry split receipt and per-vehicle/material classification.
- `vehicle-test-validation.json`: independent exported vertex **and full triangle** checks against the union of the original body/cabin/hood boxes.

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --python scripts/blender/generate_vehicles.py
node scripts/blender/split_vehicle_baseline.mjs
npm run vehicle-test:assets
npm run check
```

The baseline splitter copies original glTF geometry attributes and material/image data. It verifies that every original triangle appears exactly once in either the common town or the original vehicle set. It leaves original artifacts untouched and detects source drift with SHA-256. Do not regenerate the entire town for this test.

For browser evidence, start the local review, then run these sequentially while no other benchmark or graphics-intensive task is active:

```powershell
npm run vehicle-test:browser
node scripts/vehicle-test/verify-practice.mjs
node scripts/vehicle-test/verify-performance-repeat.mjs --original-repeat
```

The scripts use existing Playwright and installed Edge, save raw reports/captures outside the checkout under `%TEMP%/kannon-vehicle-test`, identify the actual WebGL renderer and hash the served GLBs. `--executable-path` can select the installed Edge executable. These Windows browser tests do not establish physical iPhone performance.

## Provenance and licensing

The new vehicle meshes, UVs, materials, seeded procedural maps and block lettering are original work authored for this repository. No commercial vehicle mesh, photograph, scan, third-party texture, external font, AI concept image or paid service was used. No trademarked vehicle badges are included. The new assets introduce no third-party asset license or fee; they are project-owned original work under the repository owner's licensing decisions. Blender and Three.js remain authoring/runtime tools, not asset sources.

The common town and old vehicles are copied from the repository's existing authored assets, with their existing provenance unchanged. Existing Scout/CMU motion notices remain in place. See the existing asset documentation for those unchanged sources.

The glass is opaque, tinted PBR glazing with sky reflections. It avoids transmission/refraction and a full interior, and therefore does not demonstrate transparent automotive glass. Wheel wells, panel contours, light housings, seals, grille slats and tire/rim forms are modeled geometry. This is a compact original vintage vehicle interpretation constrained by the existing game volumes, not a manufacturer-accurate scan.

The fixed collision volumes remain authoritative even where rounded corners, raked windows or wheel wells visibly recess inside them. No player or bullet can travel through those cosmetic recesses. The bus's original body collision box begins 0.16 m above the road; preserving that strict envelope also constrains the bottom of its new tires. This experiment intentionally does not redesign collision to fit every contour.

Any image produced using the optional `KANNON_VEHICLE_BLENDER_PREVIEW=1` environment variable is a **Blender preview**, not proof of browser graphics. The delivered visual evidence is captured from the actual Three.js game renderer.

## Recorded local review — September 8–9, 2026

The complete report, 25 actual Three.js captures, raw browser/practice/performance reports and integrity manifest are retained at `C:\it\kannon-fps-vehicle-evidence\REPORT.md`, outside the implementation checkout. UTC timestamps in the raw reports are September 9.

Edge 152.0.4191.66 on the Windows AMD Radeon integrated GPU measured 47.74 / 46.84 / 47.59 FPS for Before / After / Before at 1280×720, DPR 1, fixed High. Frame p95 was 33.4 ms in all three segments. The touch-emulated Auto repeat at 852×393 measured 58.74 / 59.94 / 58.74 FPS with 16.8 ms p95. These were 20-second samples after 7 seconds of warmup. GPU timings and separate original-unsplit runs varied; the report retains those results and does not claim a speedup. Physical iPhone/Safari performance is untested.

The candidate adds 1,863,136 GLB body bytes to the original town download. Bus-view draw calls rise from 67 to 100 in the paired High comparison, which loads both versions. Exported vehicle triangles rise from 3,540 to 78,580. The original unsplit town has different batching; see the report before interpreting comparison cost as production cost.

All 172 existing tests, original asset checks, build, collision-union validation, controlled browser checks and real local desktop/touch-emulated practice checks passed. The final manual-measurement guard was separately verified to reject resize-and-restore and recover for the next stable sample. Existing ANGLE precision warnings reproduce in original practice. No gameplay code outside the documented optional DEV graphics hooks was changed.

Recommendation: continue Three.js asset work, reduce distant geometry/material submissions, and perform sustained physical iPhone acceptance before proposing a release. The result is a clear geometry improvement but remains stylized, with opaque glass and bus clearance constrained by the original collision envelope. This local experiment remains unapproved for merging or deployment.
