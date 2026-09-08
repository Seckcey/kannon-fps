# Sunbreak visual and replayability upgrade

The user authorized continuous development with graphics as the highest priority and Fortnite as the quality benchmark. The existing effort/implementation and GitHub/Coastline deployment approvals remain in force. This is a direction and acceptance plan, not a claim that the prototype already meets that benchmark.

## Art target

Reference: [Sunbreak gameplay concept](art/sunbreak-v2-concept.png), generated with the built-in Image Gen tool. The direction is a coastal limestone observatory refitted as a sophisticated competitive training arena: warm ivory stone, petrol-teal metal, restrained bronze/amber accents, turquoise water, stratified cliffs, convincing pine/cypress foliage, and a distinctive distant observatory. Golden directional light, material roughness variation, contact shadows, and geometric bevels create depth while clear silhouettes and open movement routes protect competition.

Character target: athletic human proportions, contoured ivory ceramic armor over charcoal fabric, integrated helmet/reflective visor, a fixed teal pack with narrow player identification strips, proper two-handed grips, planted gait contacts and convincing upper-body actions. Target at most 30,000 exported vertices and 5 MB per shared character asset; reduce material draws where possible.

The interface retains the existing navy/cream/chartreuse palette, Barlow typography, native text and controls, readable timer/health/shield/three-slot arrangement, and current responsive controls. Gameplay imagery will be real free-look 3D built in Blender, not a background screenshot. This is an intentional adaptation of the image-led design workflow required by third-person camera motion, physical depth, animation, and authoritative collision.

The concept guides material quality, lighting, silhouette and architectural composition. Preserve existing collider volumes, spawn fairness, gate/cover gaps and route widths. Do not imitate the concept's open doorways where the actual building is solid. Retain the existing overhead gate volume; architectural relief must remain shallow and consistent with collision. Ground joints and wall modules should read at human scale. HUD numbers remain real state; concept copy never substitutes for functional UI.

## First complete slice

1. Author an original Blender environment with detailed architectural surfaces, readable tactical cover, realistic foliage silhouettes and coastal scenery. Use generated material artwork and baked surface detail where useful; retain editable source and export validation.
2. Improve the Blender scout, weapon grips and animation blending. Verify all loadout slots and movement/actions in rendered gameplay.
3. Integrate lighting, environment reflections, shadows, water, restrained effects and camera presentation; provide explicit quality scaling and measure browser rendering cost.
4. Add three active practice opponents and selectable difficulty using the same authoritative movement/combat rules. Bots can win a practice match, appear honestly in scores and never affect crew ratings. Preserve private friend matches, fixed loadout, respawns and match duration/score limit.
5. Validate visible quality against the concept and previous release, check desktop and touch UI, exercise practice and private multiplayer, run automated checks, and release verified improvements to GitHub and Coastline.

## Verification and ongoing work

The implementation now includes an editable Blender environment and scout, retained model downloads before admission, active practice rivals, a closer shared shoulder camera, baked atmospheric sky/reflections, depth-tested water, sunlight/shadows, optional depth-based contact shading and adaptive scene resolution. The optional desktop postprocessing module is downloaded separately; the touch path does not request it in Automatic mode. Floating-point rendering is capability-gated and the atmosphere has a conventional color-target fallback.

Measured issues found during iteration: excessive sky irradiance washed out stone; sea shading ran before opaque land covered it; every environment data texture used eightfold anisotropy; and contact shading redrew the entire arena and its shadows. Corrections normalize reflected light, render sea after opaque land, bound filtering by texture purpose and reuse the main depth buffer. Performance and visual acceptance must use the final build rather than those intermediate results.

Inspect actual rendered materials, character silhouette/poses, shadow grounding, architecture/foliage detail, horizon composition, HUD legibility, mobile controls and frame/draw-call measurements. A generated concept or successful build does not establish visual acceptance. Keep known intentional geometric/interface differences explicit.

Fortnite is the user's quality ambition, not a numerical guarantee inferred from a screenshot. Physical-phone performance, wide-area family play and whether the game is more enjoyable require real play evidence. Continue iterating on visible weaknesses, then extend arena variety and player feedback around the proven loop.

The previous Sunbreak V2 slice shipped through PR #3 with local/CI, desktop/touch, public browser and isolated Linux acceptance recorded in [RELEASE.md](RELEASE.md). Sunbreak V3 implementation [`884e24d`](https://github.com/Seckcey/kannon-fps/commit/884e24d422e1666a5caccc90a642da7b58de594d) is now deployed through [PR #4](https://github.com/Seckcey/kannon-fps/pull/4), with [successful main CI](https://github.com/Seckcey/kannon-fps/actions/runs/34209569042). [/health](https://kpop.8westventures.com/health) is the canonical current deployed build identity, including later documentation closeouts.

The deployed [art-depth upgrade](ART_DEPTH.md) includes asymmetric exterior terraces and a connected coastal backdrop, distinct facade/cover construction, fuller tree crowns, a more athletic weapon-ready posture and less mechanical armor silhouettes. The arena collision and game rules remain unchanged. V3 passed 79 automated tests, asset validation, TypeScript and production build checks, separate source/controller/real-input checks, and deployed HTTP/WebSocket/public HTTPS/WSS verification with matching model hashes. Its art/performance evidence and deployment results remain separate from V2's historical release evidence.

[Public rendered practice](verification/sunbreak-v3-live.json) passed on exact release `884e24d`: three rivals moved and fired, each matching V3 GLB downloaded once, and explicit exit produced no application errors. The [live capture](art/sunbreak-v3-live.png) records the deployed scene. This is browser acceptance on the tested desktop, not physical-phone or two-household proof.

Walk/Run lower-body motion now derives from the CMU Graphics Lab's selected `09_01` capture, retargeted and timed in Blender. Geometry, surfaces, rig, weapon poses and six other actions remain original. The selected source files and [provenance/usage notice](../art/source/motion/cmu-09/CMU-USAGE-NOTICE.md) are retained, and a [public model notice](../public/models/scout-motion-NOTICE.txt) carries the credit. `.gitattributes` preserves the publisher bytes used by the source hashes. This motion is not CC0 and must not be sold directly as motion data or a converted animation pack.

The runtime uses 6.5/9 m/s gait reference rates, world-up lower-body turns that preserve aim, matching cycle phase and phase rate, and interruptible blends that retain all current base-action weights. A completed Jump can donate its held outgoing pose while the one-shot restarts for another jump. A two-bone foot constraint applies only during grounded blends, preserving foot orientation, limb lengths, actor position and upper-body pose. Exported contact samples and actual-controller transition checks remain distinct; neither implies perfect foot locking, physical-phone performance or a completed family playtest.
