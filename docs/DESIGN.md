# Kannon Arena design direction

## Approved game

Third-person, no building, phone and desktop cross-play, private 2–8 player free-for-all. Five minutes or first to 15 eliminations. Three-second respawns, full starting loadout, brief spawn protection ending on fire. Slot 1 assault rifle; slot 2 shotgun; slot 3 two healing charges per life. Healing takes three seconds and restores 50 health; damage or firing interrupts it. Persistent friend-group leaderboards and match history, including monthly and all-time competition.

Implementation was authorized after the user confirmed ultra reasoning effort on 2026-09-07.

## Visual direction

Sunbreak: a bright coastal arena with cream stone, peach architectural bands, teal details, pine trees, sea and distant mountains. Original armored competitors have cream shells, orange or player-color accents, dark undersuits, a helmet visor, and legible animated silhouettes.

Menus use navy ink (#0b1928), warm white (#f7f4ea), muted seafoam (#afd6cc), and chartreuse (#d7ff5b). Barlow Condensed bold italic provides athletic display typography; Barlow supplies readable interface text. Cut-corner actions, slim borders, open spacing, and restrained translucent HUD surfaces form the component system.

## Screens

Play menu: wordmark and Play / Leaderboard / How to play navigation; Your crew. Your arena.; Good rivals. Great games.; name field; Create private match; Join with invite; Practice first; game rules and fixed loadout.

Match lobby: private invitation, connected player roster, host-controlled start, waiting feedback, ranked or practice context, and leave action.

Gameplay: world canvas, score and timer, health and shield, slots and ammo, crosshair, elimination feedback, touch controls, pause settings, and respawn countdown.

Results: winner or draw, scores, rating eligibility, rematch and return actions.

Leaderboard: authenticated friend groups, invitation-based joining, monthly/all-time standings, placement progress, and real match history. Empty states explain the next action; no seeded fake rivals or statistics.

Settings: sensitivity, audio volume, graphics, and invert-look option. Help: desktop and touch controls and match rules.

## Art implementation

The built-in Image Gen tool provides the menu illustration and material artwork plus lobby and gameplay concept references. Live characters, architecture, weapons, and effects are modeled 3D geometry. This is an intentional deviation from raster sprite guidance: free-look third-person gameplay requires consistent depth, animation, shadows, and server-aligned collision from every angle. Concept art establishes direction, not a claim of final production fidelity for procedural 3D models.

Generated asset prompts and saved production paths are recorded in assets documentation. Interface text, buttons, scoring, and controls remain native application elements.
