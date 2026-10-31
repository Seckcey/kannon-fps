# Kannon Arena design direction

## Approved game

First person, no building, phone and desktop cross-play. Free-for-all (first to 15 eliminations) or Team Deathmatch (two teams, first team to 30), five-minute rounds, up to eight people with optional bots in casual rooms. 100 health that starts to refill 4 seconds after the last damage (2.5 seconds with Second Wind); no shield and no healing items. Three-second respawns with 1.5 seconds of spawn protection that ends when you fire, throw a grenade or use the knife. Classes: Assault (KR-5 Carbine), Close Quarters (Hornet 9), Marksman (Heron 7 bolt-action rifle) and Custom, each with the Sentry 9 pistol, a frag grenade and a knife; perks Quick Hands or Deep Pockets, Quiet Step or No Trace, Second Wind or Cool Head; rewards Recon Sweep (3), Mortar Volley (5) and Attack Drone (7). Persistent friend-crew leaderboards and match history, with monthly and all-time competition; ranked crew matches are free-for-all.

The first-person overhaul was requested on 2026-10-30 and is described in its [design](superpowers/specs/2026-10-30-first-person-combat-overhaul-design.md). The original third-person game was authorized on 2026-09-07; the [release history](RELEASE.md) describes that earlier build.

## Visual direction

[Kannon Town v3](TOWN_V3.md): the family's neighbourhood street taken over by a military checkpoint after an evacuation. Sandbag walls, concrete barriers, ammunition crates under tarps, a canvas-covered cargo truck, a faded evacuation bus, a burnt-out car, boarded windows, wire on the fences and distant smoke. The light is late afternoon: a low warm sun, long shadows across the street, cool shade and haze. Desktop adds a filmic grade (slightly desaturated, warm highlights, cool shadows, vignette, light grain), aim-down-sights depth of field and bloom on flashes; phones get one cheap grade-and-vignette pass.

Other players are [soldiers in dark tactical gear](OPERATOR_ART.md) with a team-coloured patch: blue for friends and red for enemies in Team Deathmatch, each player's own colour in free-for-all. Your view shows [original weapons and gloved hands](WEAPONS_ART.md) with worn metal, polymer and wood, and no markings. Hits show dark puffs, dust, splinters and sparks, never blood.

Menus keep navy ink (#0b1928), warm white (#f7f4ea), muted seafoam (#afd6cc) and chartreuse (#d7ff5b). Barlow Condensed bold italic is the display type; Barlow is the reading type. Cut-corner actions, slim borders and open spacing form the menu components. The in-match HUD is its own tactical style: Barlow Condensed in white on dark translucent panels with thin corner brackets, blue (#4aa3ff) for friends, red (#ff5a4f) for enemies and amber (#ffc04d) for highlights such as mortar targets, drones, north on the minimap and the crosshair when Simple firing has a target.

Earlier directions are kept as history: the first Sunbreak coastal observatory ([concept](art/sunbreak-v2-concept.png)) and the bright Kannon Town of [v2](TOWN_V2.md).

## Screens

Play menu: wordmark and Play / Games / Leaderboard / How to play navigation; **Your crew. Your arena.**; **Good rivals. Great games.**; player name; Create match; Available Games; Play against bots; Join with invite; a strip with 1–8 people + bots, 5 minutes, solo or teams; and your current loadout with **Change**.

Create match: Free-for-all or Team Deathmatch (ranked forces free-for-all), Public or Private, **Fill to 4 players with bots** for casual games, and a crew choice for ranked games.

Match lobby: invitation, connected roster (by team in Team Deathmatch), host-controlled start, waiting feedback, ranked, casual or practice context, your loadout and leave action.

Loadout: the three ready-made classes and Custom. Custom picks a primary, with bars comparing damage, fire rate, range, mobility and aim speed, and one perk from each slot. Open it from the lobby, the pause menu or while waiting to respawn; a change during a match applies at the next spawn.

Round preparation: after host start or rematch, load and draw the current round before showing **Ready to play**. Each person deliberately engages controls; the roster shows readiness. The full three-second countdown follows everyone's acknowledgment. Preparation expires to the lobby after 45 seconds, with a retry explanation. Old game pages receive a refresh instruction. See [Round readiness](ROUND_READINESS.md).

Practice setup: Relaxed, Balanced or Challenging rivals, with a short plain-language explanation for each. Three clearly labelled AI rivals use the same rules, respawns, round clock and win condition; practice never changes crew rankings. Model downloads finish before room admission, cancelling stays available, and downloaded models are reused when the 3D scene loads.

Gameplay: the first-person view with your weapon; a rotating minimap at top left; score and clock (a team bar in Team Deathmatch); kill feed with weapon icons and headshot marks; a crosshair for each kind of weapon, hidden while sprinting and while aiming; hit and elimination markers; the scope overlay for the Heron 7; damage direction arcs and a low-health edge; grenade warnings; the ammo panel with weapon name, magazine, reserve and frags; a health bar shown below 100; stamina; the reward tray and the mortar target map; score pop-ups and medals; the "eliminated by" card and respawn countdown; the scoreboard with teams and eliminations, deaths and assists; touch controls; and the pause menu.

Results: winner, winning team or draw, scores, top scorer, rating eligibility, rematch and return actions.

Leaderboard: authenticated friend crews, invitation-based joining, monthly and all-time standings, placement progress and real match history. Empty states explain the next action; there are no seeded fake rivals or statistics.

Settings: look and aim sensitivity, field of view, invert vertical look, hold or toggle for aim and crouch, sprint mode, reduce camera motion, graphics, game volume with a test sound, mobile firing, and optional gyroscope aiming with its own sensitivity. Help: desktop and phone controls, modes, classes, rewards and match rules.

Graphics adapts scene resolution after about two seconds of slow frames while native HUD text and controls stay sharp. On a desktop, Automatic first turns off the post-processing look, then lowers resolution; High keeps the full look (SMAA edges, sharper contact shading, slight edge colour fringing) and a higher resolution floor. A brief hitch or time in another app does not lower quality. Fifteen seconds of fast frames raise scene resolution again in small steps. Low, and Automatic on touch devices, use the phone tier: smaller textures, a smaller character shadow, no grass cards and no post-processing; Low keeps a fixed resolution. Every tier keeps the same geometry, collision and gameplay rules.

## Art implementation

The built-in Image Gen tool provided the menu illustration and earlier concept references. Live characters, weapons and architecture are 3D geometry generated in Blender from code, and combat effects are built in code at run time. The town also uses CC0 Poly Haven textures and twenty CC0 Poly Haven street props, as its records list. This is an intentional departure from raster sprite guidance: a first-person view with free look needs consistent depth, animation, shadows and collision that matches the server from every angle. Concept art sets direction; it is not a claim about the final look of the generated 3D models.

Generated asset prompts and saved production paths are recorded in the assets documentation. Interface text, buttons, scoring and controls are native application elements.
