# Kannon Arena design direction

## Approved game

Third-person, no building, phone and desktop cross-play, private 2–8 player free-for-all. Five minutes or first to 15 eliminations. Three-second respawns, full starting loadout, brief spawn protection ending on fire. Slot 1 assault rifle; slot 2 shotgun; slot 3 two healing charges per life. Healing takes three seconds and restores 50 health; damage or firing interrupts it. Persistent friend-group leaderboards and match history, including monthly and all-time competition.

Implementation was authorized after the user confirmed ultra reasoning effort on 2026-09-07.

## Visual direction

Sunbreak: a bright coastal observatory with weathered ivory limestone, petrol-teal fittings, restrained bronze details, umbrella pines, cypresses, turquoise sea and stratified cliffs. Original armored competitors have contoured cream ceramic shells, dark fabric undersuits, a reflective helmet visor, a fixed teal equipment pack and small player-color identification strips. The first menu illustration retains its peach coastal palette; live arena materials follow the more detailed [Sunbreak concept](art/sunbreak-v2-concept.png).

Menus use navy ink (#0b1928), warm white (#f7f4ea), muted seafoam (#afd6cc), and chartreuse (#d7ff5b). Barlow Condensed bold italic provides athletic display typography; Barlow supplies readable interface text. Cut-corner actions, slim borders, open spacing, and restrained translucent HUD surfaces form the component system.

## Screens

Play menu: wordmark and Play / Leaderboard / How to play navigation; Your crew. Your arena.; Good rivals. Great games.; name field; Create private match; Join with invite; Practice first; game rules and fixed loadout.

Match lobby: private invitation, connected player roster, host-controlled start, waiting feedback, ranked or practice context, and leave action.

Round preparation: after host start or rematch, load and render the current round before showing **Ready to play**. Each human deliberately engages controls; the roster shows readiness. The full three-second countdown follows all acknowledgments. Preparation expires to the lobby after 45 seconds, with a retry explanation. Old game pages receive a refresh instruction. See [Round readiness](ROUND_READINESS.md).

Practice setup: Relaxed, Balanced or Challenging opponents, with a short plain-language explanation for each. Three clearly labelled AI rivals share the regular loadout, respawns, round clock and win condition; practice never changes crew rankings. Model downloads finish before room admission, cancellation stays available, and successful model buffers are reused when loading the 3D scene.

Gameplay: world canvas, score and timer, health and shield, slots and ammo, crosshair, elimination feedback, touch controls, pause settings, and respawn countdown.

Results: winner or draw, scores, rating eligibility, rematch and return actions.

Leaderboard: authenticated friend groups, invitation-based joining, monthly/all-time standings, placement progress, and real match history. Empty states explain the next action; no seeded fake rivals or statistics.

Settings: sensitivity, audio volume, graphics, and invert-look option. Help: desktop and touch controls and match rules.

Graphics adapts scene resolution after sustained slow rendering while preserving native HUD text and controls. Automatic mode can remove optional contact shading first; High retains that shading when floating-point targets are supported and keeps a higher resolution floor. A brief hitch or time in another app does not lower quality. Returning to a consistently fast frame rate raises scene resolution gradually; contact shading disabled by Automatic stays off until graphics are reconfigured. Low bounds scene pixel count and omits shadow maps/contact shading. All tiers preserve the same geometry, collision and gameplay rules.

## Art implementation

The built-in Image Gen tool provides the menu illustration and material artwork plus lobby and gameplay concept references. Live characters, architecture, weapons, and effects are modeled 3D geometry. This is an intentional deviation from raster sprite guidance: free-look third-person gameplay requires consistent depth, animation, shadows, and server-aligned collision from every angle. Concept art establishes direction, not a claim of final production fidelity for procedural 3D models.

Generated asset prompts and saved production paths are recorded in assets documentation. Interface text, buttons, scoring, and controls remain native application elements.
