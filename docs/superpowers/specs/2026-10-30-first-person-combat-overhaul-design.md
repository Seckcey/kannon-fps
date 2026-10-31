# First-person combat overhaul — design

Requested by Frank on 2026-10-30: make Kannon Arena's one map and game look and play like a
current big-studio modern military multiplayer shooter, "the same or better". Frank granted
build, commit, merge and deploy permission and offered Unreal Engine as an option. This
document is waiting for his go-ahead before any code changes (his global rule: no coding until
scope is approved).

## Intent

Today Kannon Arena is a bright, third-person family arena: armoured "scout" characters, an
assault rifle, a shotgun and two heal charges, a shield bar, and a sunny two-house street.
Frank wants it to feel like the current big military shooter: you see your hands and gun,
aim down the sights, sprint, slide and vault, guns that kick and sound heavy, hit markers,
a minimap, team play, and a grittier, more realistic look.

The father-and-son, phone-plus-desktop, play-from-a-link product stays. The overhaul changes
how the game plays and looks, not who it is for.

## Decisions made (builder's calls, stated to Frank)

1. **Stay on the browser engine (Three.js), not Unreal.** Unreal 5 cannot run in a web browser,
   and an iPhone build needs a Mac, Xcode and a paid Apple developer account. Kannon plays on an
   iPhone from a link. Unreal would also throw away the working lobby, readiness, crews,
   ratings, bots and deployment, and turn the game into a multi-gigabyte Windows download.
   Unreal would look better on a gaming PC; it would cost the phone and months of rebuild.
2. **First person for everyone.** The over-the-shoulder camera goes away. A third-person
   camera lets you see around corners, which is unfair against first-person players. Other
   players are still drawn as full bodies.
3. **Original, not a copy.** Same kind of game (genre conventions: aim down sights, sprint,
   slide, vault, recoil, hit markers, minimap, kill feed, team modes, streak rewards), but our
   own weapon names and designs, map, HUD layout, perk and reward names, and look. No
   *Call of Duty* names, logos, maps, modes with signature names, or interface copies.
4. **Health works like the genre.** 100 health that refills after a short pause out of combat.
   Shield and heal charges are removed.
5. **Honest ceiling.** A big studio's art comes from scanned real objects and motion capture by
   a very large team. Ours is original geometry generated in Blender from code, dressed with free
   (CC0) Poly Haven textures and town props, plus the credited CMU walk and run capture. It can
   look clearly grittier and more realistic than today; it will not match a big-studio game frame
   for frame. Purchased asset packs (Frank's card) remain the upgrade path, recorded in
   `art/PURCHASED_ASSETS.md`.

## Research summary (what the genre does in 2026)

Sources: a publisher's multiplayer systems post for a current big-studio military shooter
(2026-08-21) and a PC Gamer review of that game (2026-10). Used to choose genre mechanics, not
to copy content.

- Movement: grounded "boots on the ground"; sprint plus a stamina-limited faster sprint whose
  stride changes as stamina runs out; slide from sprint; a longer, lower slide; vaulting
  (mantling) that keeps momentum, can be steered or cancelled, allows aiming, and can chain into
  a slide; ledge hang and pipe climb. There is no omnidirectional diving.
- Gunplay: no random hip-fire bloom — shots go where the gun points; sway, recoil and movement
  still matter. Recoil moves the weapon and the bullets together. Weapon and world share one
  field of view. Muzzle smoke is kept clear of the aim point. Aim-down-sights depth of field
  blurs the gun, not the target. Weapons retract near walls. Fast time to kill.
- Combat feedback: heavy, layered, loud gun audio; hit markers; kill feed; minimap with radar
  pings; reactive environment (glass, pots, debris).
- Systems: create-a-class with primary, secondary, lethal, tactical, three perks and streak
  rewards per class; three starter classes (close, long, balanced); streaks from kills and
  objective play; respawn team modes; a fixed-spawn team mode was the review's highlight.
- Common criticism: spawns behind you, streaks that snowball, every gun tuned to zero recoil.

## Goals

- Playing feels like a modern military first-person shooter within the first ten seconds.
- Your own shots respond instantly (local prediction), and hits register where you aimed even
  across homes (server rewind / lag compensation).
- Grittier, more realistic Kannon Town without losing the layout the family knows.
- Phones keep a playable frame rate; desktop gets the extra effects.
- Each phase ships to Coastline and is playable on its own.

## Non-goals

- No engine change, no native app, no Unreal.
- No battle royale, extraction mode, vehicles, campaign, progression grind, purchases, voice or
  text chat.
- No ledge hang, pipe climb, prone or supine slide in this project (possible later).
- No new map; Kannon Town is re-dressed and gains cover.

## Anti-goals (would be failure even if it "works")

- Copying *Call of Duty* names, maps, HUD or branding.
- Shots that visibly hit but do not count, or your own gun reacting a ping late.
- Phones dropping to an unplayable frame rate.
- Spawning players behind each other (the genre's most hated flaw).
- Gore. Hits use dark puffs and screen effects, never blood spray or dismemberment.

## Constraints

- Server stays authoritative: clients send inputs only. One Node process, 30 Hz simulation,
  snapshots at 15 Hz (may rise to 20 Hz if Coastline measurements allow).
- Shared deterministic movement code in `shared/` for server and client prediction.
- `WORLD_VERSION` bumps to `kannon-town-v3`; older pages get the existing refresh notice.
- Builds, test copies and previews run on `ssh coastline` in a separate task directory and
  Compose project; production is `/srv/8west/apps/kannon-fps`, project `kannon-arena`.
- Blender 5.2.1 and KTX tools live on Frank's PC (see project memory); bakes run there.
- No downloads beyond the existing Poly Haven CC0 fetch without asking Frank.

## Design

### 1. First-person camera and viewmodel

- Eye height: standing 1.62 m, crouched 1.12 m, sliding 0.95 m. Camera follows predicted
  position with landing dip, step bob and a short camera roll on slide.
- Viewmodel (arms + weapon) rendered after the world with cleared depth so it never clips into
  walls, using the same field of view as the world. When the muzzle is within ~0.6 m of a wall
  the weapon retracts (lowers and pulls back) and cannot fire until clear — prevents firing
  through cover the camera is pressed against.
- Procedural motion layered in code: look sway (lag), movement bob tied to stride, sprint pose,
  faster-sprint pose (weapon raised), slide tilt, jump and landing, ADS transition with the sight
  aligned to screen centre, recoil kick (back, up, roll), reload choreography (tilt, magazine out,
  magazine in, charging handle), weapon swap, knife swing, grenade throw.
- Models generated by a new Blender script (`scripts/blender/generate_weapons.py`): carbine,
  SMG, pump shotgun, bolt rifle with scope, pistol, knife, frag grenade, gloved arms with
  sleeves. Physically based materials (anodised metal, polymer, wood, worn edges) baked to
  textures, exported as KTX2 GLB like the town. Original designs and names.

### 2. Movement (shared physics, server authoritative)

Numbers are starting values; tune in playtests.

| Item | Value |
| --- | --- |
| Walk / back / strafe | 5.0 / 4.0 / 4.5 m/s |
| Aim-down-sights walk | 2.6 m/s × weapon factor |
| Crouch walk | 2.6 m/s |
| Sprint | 6.9 m/s, forward only |
| Dash (double-tap sprint) | 8.2 m/s for up to 3 s of stamina, refills in 4 s; stride and pose show fatigue |
| Acceleration / braking | 40 / 30 m/s² on ground, 20% in air |
| Jump | ~0.95 m apex (gravity 19, launch 6.0 m/s) |
| Slide | crouch while sprinting/dashing: start ≥ 8.8 m/s, eases to 3.5 m/s over 0.8 s; jump cancels it keeping 90% speed; 0.6 s cooldown |
| Vault (mantle) | jump into an edge 0.5–2.1 m high: 0.25 s + 0.15 s per metre, keeps momentum, steerable, can aim, fire after 70%, crouch held chains into a slide; thin walls/railings vault over |
| Step-up | 0.45 m (unchanged) |

Player state gains posture (stand, crouch, slide, vault), stamina, slide and vault timers. The
collision height follows posture (1.8 / 1.25 / 1.0 m). Prediction replays the same code.

### 3. Gunplay

- Weapon table in `shared/weapons.ts` (single source for server, client, bots and HUD).

| Weapon | Rate | Damage near → far | Head × | Mag | Reload | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| KR-5 carbine (AR) | 750 rpm | 28 → 22 (20–40 m) | 1.4 | 30 | 2.1 / 2.6 s | default primary |
| Hornet 9 (SMG) | 900 rpm | 25 → 17 (10–25 m) | 1.25 | 32 | 1.9 s | faster sprint-to-fire |
| Breaker 12 (pump) | 70 rpm | 8 × 14 → 8 × 4 (7–20 m) | 1.0 | 6 | 0.45 s per shell | fixed pellet pattern |
| Heron 7 (bolt rifle) | 48 rpm | 120 head/torso, 80 legs | — | 5 | 2.8 s | 4.2× scope, sway, hold breath |
| Sentry 9 (pistol) | semi, 150 ms cap | 34 → 22 (12–30 m) | 1.4 | 12 | 1.5 s | secondary |
| Knife | 0.6 s | one-hit within 1.6 m, short lunge | — | — | — | quick melee |
| Frag grenade | 1 per life | 100 within 3 m → 20 at 6 m | — | — | — | cook up to 3.4 s, bounces |

Names in this table are the shipped display names. The first draft used the working names Vespa 9
(now Hornet 9) and Longbow (now Heron 7); Longbow was dropped because another shooter already uses it
for the same kind of rifle. Internal ids (`hornet9`, `longbow`) did not change.

- No hip-fire bloom: hip and aimed shots go to the crosshair centre. Accuracy comes from
  recoil (per-weapon repeatable climb and drift applied to the view and partly recovered),
  movement sway applied to the view, flinch when hit, and the bolt rifle's large fixed hip
  spread. The client sends the resulting yaw and pitch, so the server traces exactly what the
  player saw.
- Fire cadence uses an accumulator (`lastFire += interval` while held) so 30 Hz ticks keep the
  true rate.
- Hit boxes by posture: head, torso, legs (×0.85), all yaw-independent. Crouch and slide lower
  them.
- Lag compensation: each input frame carries `viewTime`, the server time of what the client was
  drawing. The server keeps one second of position history and traces targets rewound to that
  time, clamped to at most 400 ms back. Map collision is static. (The first cap, 200 ms, was
  raised in review: the client draws opponents 100 ms behind the newest snapshot, and with tick
  and frame waits that left only about 50–100 ms for the network, so shots at moving targets
  stopped counting above about 100 ms round trip. 400 ms covers about 100 ms each way even on
  30 Hz phone frames; the cost is that a slow client can hit someone up to 400 ms after they
  reached cover.)
- Local fire prediction: muzzle flash, recoil, sound, tracer and ammo count happen instantly on
  the shooter's screen; the server's shot event confirms impacts and hit markers.
- Health 100; regeneration starts 4 s after the last damage at 50 health per second.
  Spawn protection 1.5 s, ending when the player fires, throws a grenade or uses the knife.
  Respawn 3 s.
- Ammo: magazine plus reserve (4 spare magazines); each elimination returns one magazine.

### 4. Feedback and HUD (own design language)

- Crosshair per weapon class, hidden while sprinting and while aiming down sights.
- Hit marker (white), elimination marker (red), headshot variant, matching sounds.
- Damage direction arcs; screen edge reddens and desaturates as health drops; heartbeat and
  muffled audio at low health.
- Kill feed with weapon icon and headshot mark.
- Minimap (top left) drawn from the collision map: you, teammates, and enemies who fire
  unsuppressed (brief pings) or during a Recon Sweep.
- Ammo panel: weapon name, magazine / reserve, grenade count, streak progress.
- Score pop-ups (+100 elimination, +50 headshot) and short medals with original names.
- "Eliminated by" card with weapon and distance; optional short kill replay (phase C).
- Touch layout for first person: left stick (push to the top edge to sprint, again to dash),
  right side look, left and right fire, aim, crouch/slide, jump/vault, reload, grenade, knife,
  weapon swap. Simple mode auto-fire is kept.
- Settings add field of view, aim sensitivity multiplier, hold or toggle for aim and crouch,
  sprint mode, and reduced camera motion.

### 5. Audio (procedural Web Audio, no downloads)

- Guns: layered transient click, body burst, low thump and mechanical action per weapon; a
  generated reverb tail that is roomy indoors and slapback outdoors; distance low-pass and speed
  of sound delay; near-miss crack.
- Footsteps per surface (asphalt, wood, grass, concrete) by speed; enemy steps positioned in 3D.
- Foley: magazine out and in, bolt, aim rustle, slide scrape, landing, vault, grenade bounce and
  explosion, hit tick, elimination thump, headshot ping.
- Ambience: wind, distant artillery and gunfire, occasional helicopter pass.

### 6. Look (phase B)

- Kannon Town becomes a street taken over by a military checkpoint after an evacuation: sandbag
  walls, concrete barriers, a canvas-covered military cargo truck (replacing the box truck in
  the same footprint), a burnt-out car, barbed wire, ammo crates, tarps, debris, boarded and
  broken windows, scorch marks, traffic cones, distant smoke columns.
- New mid-street cover is added to `shared/map.ts` and the Blender layout together, keeping
  stairs, houses and lanes.
- Re-bake at late-afternoon light: low warm sun, long shadows, cool shade, haze.
- Grade: filmic, slightly desaturated, warm highlights and cool shadows, vignette, light grain.
  Desktop adds aim-down-sights depth of field, muzzle light flashes and existing bloom and
  contact shadows. Phones get one cheap grade-and-vignette pass.
- Operators: the scout re-skinned to dark tactical gear (plate carrier, helmet, gloves) with a
  team-coloured patch; same rig and animations.
- Effects: muzzle flash geometry and smoke, ejected shells, tracers every third round, impact
  dust/splinters/sparks by surface, bullet-hole decals on wall faces, breakable window glass and
  pots (cosmetic, driven by shot traces), grenade explosion with debris and screen shake.

### 7. Modes, classes and rewards (phase C)

- Modes: Free-for-all (existing) and Team Deathmatch (2 teams, up to 4 v 4, teams spawn on
  their house's side; spawns never put you behind a visible enemy). Later candidate: three-point
  capture mode.
- Classes: three starters (Assault: carbine + pistol + frag; Close Quarters: SMG + pistol + frag;
  Marksman: bolt rifle + pistol + frag) and one custom class: primary, secondary, lethal and
  three perks (one per slot, original names such as Quick Hands, Quiet Step, Second Wind, No
  Trace, Cool Head, Deep Pockets). Chosen before spawning and between lives.
- Streak rewards (kills, reset on death): 3 Recon Sweep (enemies on minimap 20 s), 5 Mortar
  Volley (pick a spot on the map; three shells after a warning whistle), 7 Attack Drone (circles
  for 25 s and fires at visible enemies; can be shot down).
- Earlier names, changed before release because other shooters already use them: Low Profile is
  now No Trace, Steady Aim is now Cool Head, and Mortar Strike is now Mortar Volley. Internal ids
  (`low-profile`, `steady-aim`, `mortar`) did not change.
- Ranked crew matches remain free-for-all and keep their rating rules. Team Deathmatch is casual.

### 8. Bots

Bots keep their navigation and senses and switch to the new rules: eye-height aim with head
and torso targets, loadout weapons, cover and backing off to regenerate instead of healing,
occasional slides, frag grenades on Challenging, and team awareness.

## Phases and acceptance

- **Phase A — First person and gunplay**: sections 1–5 with carbine, pistol, shotgun, knife;
  bots updated; tests rewritten; deployed. Accept: first-person play on desktop and touch
  emulation, local shots instant, hits register with simulated 100 ms latency, phone tier frame
  rate no worse than today in emulation, all checks green.
- **Phase B — Look**: section 6. Accept: before/after captures from the existing capture
  harness, phone frame rate measured, assets validated.
- **Phase C — Modes and systems**: sections 3 (SMG, bolt rifle, frag), 7 and remaining HUD.
  Accept: Team Deathmatch with bots and two browsers, rewards working, deployed.

Each phase: update docs (`README.md`, `docs/ARCHITECTURE.md`, `docs/RELEASE.md`), PR, merge,
deploy to Coastline, verify `/health` and a live match.

## Risks

- Phone performance with viewmodel and effects: phone tier stays lean; measure each phase.
- Movement prediction mismatch with new states: one shared code path, replay tests.
- Generated art quality: honest ceiling; purchased packs as upgrade.
- Fast time to kill on touch: Simple auto-fire kept; tune damage in playtest.
- Large test churn: rewrite tests alongside each system.

## Left to the builder

Exact tuning numbers, model detail level, HUD styling, sound design, file structure, and the
order of work inside each phase.
