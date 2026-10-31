# First-Person Combat Overhaul Implementation Plan

> **For agentic workers:** this plan is executed as parallel workstreams, one agent per workstream,
> each in its own git worktree branched from the contract commit. Read the spec first, then your
> workstream section, the Shared Contract, and the files you own. Steps use checkbox syntax.

**Goal:** Turn Kannon Arena into a first-person modern military shooter (all three phases of the
spec) on the existing Three.js client and authoritative Node server, phones included.

**Architecture:** Shared deterministic rules (`shared/`) drive the server simulation and client
prediction. The server stays authoritative and rewinds hit checks to what the shooter saw. The
client renders a first-person camera plus a separate viewmodel scene, predicts its own shots for
instant feedback, and feeds a React HUD through `HudStore`. Art comes from Blender scripts.

**Tech Stack:** TypeScript 5.9, Three.js r185, React 19, Vite 8, Node 24 (`node:test` via `tsx`),
ws, SQLite; Blender 5.2.1 (Python), glTF-Transform 4.5, KTX-Software 4.4.2.

**Spec:** `docs/superpowers/specs/2026-10-30-first-person-combat-overhaul-design.md`

## Global Constraints

- Original content only: no *Call of Duty* names, maps, modes with signature names, HUD copies or branding. Weapon, perk, reward and medal names come from `shared/weapons.ts` / `shared/protocol.ts`.
- No gore: hits are dark puffs and screen effects.
- Phones stay playable: phone tier keeps its budgets (no post-processing composer, halved particles).
- Server authoritative; clients send `InputFrame`s only. `WORLD_VERSION` is `kannon-town-v3`.
- Plain-English player-facing copy (short sentences, no jargon).
- Do not edit `shared/protocol.ts`, `shared/weapons.ts`, `src/game/hud.ts`, `src/game/assets.ts` or `package.json`. Report needed changes in `contractRequests`.
- Do not change public signatures of contract stubs you do not own. Owners may add members but must keep the listed ones.
- No new npm dependencies. No downloads (CC0 assets already under `C:\it\kannon-assets\polyhaven`).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Containers/Docker are never run on this desktop (global rule); this plan needs none until integration.

## Review Focus

1. Shots at strafing players across ~100 ms latency must register where the shooter aimed (rewind uses `viewTime`, clamped to 200 ms) — A owns the test.
2. Prediction and server must agree through slide → jump → vault → land chains; no rubber-banding on stairs or windows — C and P own replay-parity tests.
3. Touch players (simple auto-fire) must still be able to fire, aim, crouch, throw and use rewards in landscape on a phone-sized viewport — C and E own tests.
4. Malformed or hostile inputs (NaN view time, mortar target outside the arena, streak not earned, loadout with two slot-1 perks) are rejected without crashing the room — A owns tests.
5. Respawns never place a player in an enemy's line of sight when another spawn is hidden — A owns the test.

---

## Shared Contract (committed before the workstreams start)

| File | Defines |
| --- | --- |
| `shared/protocol.ts` | `WORLD_VERSION`, modes, teams, postures, weapon/perk/reward/medal ids, `Loadout`, `InputFrame`, `PublicPlayerState` / `PlayerState`, `ShotTrace`, `DroneState`, `ReconState`, `MortarState`, `GameEvent`, `WorldSnapshot` (with `self`), messages (`loadout`, `create.mode`), `RULES`, `SCORE_POINTS` |
| `shared/weapons.ts` | `WEAPONS` table, `damageAt`, `PELLET_PATTERN`, `fireIntervalMs`, perks, streaks, `EXPLOSIVES`, `explosionDamage`, `DRONE`, `LOADOUT_PRESETS`, `DEFAULT_LOADOUT`, `sanitizeLoadout`, `weaponFor`, perk factors |
| `shared/physics.ts` | v1 of movement: `movePlayer(state, input, ctx): MoveEvents`, `MoveState`, `MoveContext`, `moveDefaults`, `MOVE`, `POSTURE_HEIGHT`, `EYE_HEIGHT`, `eyePosition`, `weaponMuzzle`, `hitboxes`, `rayHitboxes`, `findVault`, `spaceFree`, `raycastMap`, `raycastMapDetailed`, grenade `stepGrenade` / `grenadeLaunch` / `GrenadeTrajectory` / `grenadePosition`. `cameraPosition` and `muzzlePosition` are gone (first person). |
| `shared/map.ts` | 8 new cover boxes (frozen positions), `surfaceOf`, `groundSurfaceAt`, `surfaceAt` |
| `src/game/hud.ts` | `HudFrame`, `HitMarker`, `DamageArc`, `GrenadeWarning`, `MinimapBlip`, `HudStore` |
| `src/game/assets.ts` | URLs: `operator-v1.glb`, `weapons-v1.glb`, `environment-v3(-phone).glb` (placeholders committed: copies of v2 art and an empty weapons GLB) |
| `src/game/ViewModel.ts`, `src/game/WeaponModels.ts` | Stub classes with the final public surface |
| `src/game/GameAudio.ts` | Final public method list, interim synthesis |
| `src/game/CombatEffects.ts` | Final public method list (plus `setDrones(drones: DroneState[], serverTime: number)` to add), interim bodies |
| `src/game/Presentation.ts` | `setOverlay`, `setAim`, `setCondition`, `drawsOverlay` stubs |
| `src/game/RenderTiers.ts` | Tier fields `depthOfField`, `effects`, `muzzleLight`, `decals` |
| `src/game/Atmosphere.ts` | `SUN_DIRECTION`, `SUN_COLOR`, `SUN_INTENSITY`, `HEMISPHERE`, `FOG`, `EXPOSURE`, `SKY_LIGHT_INTENSITY` |
| `src/game/World.ts` | `ArenaWorld.breakables` (meshes named `Breakable*`) |

Cross-workstream interfaces not in a file yet:

- **Bots (B → A):** `PracticeBots.input(player: PlayerState, others: readonly PlayerState[], now: number, dt: number, seq: number, mode: GameMode): InputFrame`; bot loadouts come from `botLoadout(id, difficulty)` in `shared/weapons.ts`.
- **Engine (A → tests/clients):** `MatchEngine` options gain `mode?: GameMode`; `engine.setLoadout(id, loadout)`; `engine.snapshot(now?, viewerId?)` returns public players plus `self` for the viewer; `addPlayer(profile, now?, bot?, team?)` assigns a balanced team in `tdm` when `team` is omitted.
- **InputController (C → E):** `InputSettings { sensitivity; adsSensitivity; invertY; firingMode; gyroscope; gyroSensitivity; aimMode: 'hold'|'toggle'; crouchMode: 'hold'|'toggle'; sprintMode: 'hold'|'toggle'|'auto' }`; `InputAction = 'fire'|'aim'|'jump'|'sprint'|'reload'|'crouch'|'melee'|'grenade'`; methods `setAction`, `cancelAction`, `toggle(action: 'aim'|'crouch'|'sprint'): boolean`, `swapWeapon()`, `setSlot(slot)`, `useStreak(reward)`, `setStreakTarget(target | null)`, getter `mortarTargeting`, `setViewTime(ms)`, `addViewKick(yaw, pitch)`, plus every existing public member. `TouchRole = 'move'|'look'|'fire'|'fire-left'|'jump'|'reload'|'grenade'|'melee'` (elements carry `data-touch`).
- **GameView (C → E):** `new GameView(container, { input, hud: HudStore, getSnapshot, getPlayerId, onStats?, onAssetsReady?, getPreparationId?, onPreparationRendered?, onError?, settings? })`; methods `handleEvent`, `recordInput`, `prepareAutomaticFire(): boolean`, `setSettings(Partial<GameSettings>)`, `testSound()`, `dispose()`, `canvas`. `GameSettings = { sensitivity; adsSensitivity; volume; quality; invertY; fov; reduceMotion }`.
- **Settings (E → C):** `Settings` in `src/lib/storage.ts` gains `adsSensitivity` (0.3–2, default 1), `fov` (horizontal degrees 70–110, default 90 desktop / 80 touch), `aimMode` ('hold' desktop, 'toggle' touch), `crouchMode` ('toggle'), `sprintMode` ('hold' desktop, 'auto' touch), `reduceMotion` (false), `loadoutPreset: LoadoutPreset` ('assault'), `customLoadout: Loadout` (`DEFAULT_LOADOUT`).
- **Connection (C → E):** `ConnectionState.events` keeps the last 128 events; new `feed: GameEvent[]` keeps the last 40 events that are not `shot` or `damage`.
- **Weapons GLB (H → D, C):** root nodes `weapon_kr5`, `weapon_hornet9`, `weapon_breaker12`, `weapon_longbow`, `weapon_sentry9`, `knife`, `frag`, `arm_left`, `arm_right`. Weapon children: empties `grip_r`, `grip_l`, `muzzle`, `sight`, `eject`; meshes `mag` and optional `action` (bolt/slide/pump). Metres, forward −Z, up +Y. Arms: origin at the palm grip point, forearm toward +Z.
- **Operator GLB (I → C):** scout rig bone names unchanged (`root, pelvis, spine, chest, neck, head, upper_arm_l, forearm_l, hand_l, upper_arm_r, forearm_r, hand_r, thigh_l, shin_l, foot_l, thigh_r, shin_r, foot_r`), clips `Idle, Walk, Run, Jump, Aim, Fire, Reload` (+ optional `Crouch`, `CrouchWalk`, `Slide`), material `PlayerAccent` for team/player colour, no weapon meshes, an empty `weapon_socket` under `hand_r`.
- **Environment GLB (J → C, G):** breakable cosmetic meshes named `Breakable_Glass_*` / `Breakable_Pot_*`; every `OBSTACLES` box (including the 8 new cover boxes) has matching render geometry.

## File Ownership

| Workstream | Owns |
| --- | --- |
| P Physics | `shared/physics.ts`, helper functions in `shared/map.ts` (obstacle data frozen), `tests/shared/**` |
| A Server | `server/engine.ts`, `server/app.ts`, `server/store.ts`, `tests/server/{engine,combat-feedback,transport,practice-transport,preparation,public-games,store}.test.ts`, `tests/acceptance/**` |
| B Bots | `server/bots.ts`, `server/navigation.ts`, `tests/server/{bots,bot-platform}.test.ts` |
| C Client core | `src/game/{GameView,InputController,TouchGestures,MovementPrediction,AutomaticFire,BlenderCharacter,Character,CharacterImpact,CharacterBlend,GaitTurn,LegContact,LocomotionVelocity,DeferredRespawns,Gyroscope,PreparationReadiness,index}.ts`, new `src/game/{FirstPersonCamera,LocalWeapon,RemotePlayers,HudFeed}.ts`, `src/lib/connection.ts`, client tests for those files |
| D Viewmodel | `src/game/ViewModel.ts`, `src/game/WeaponModels.ts`, new `src/game/viewmodel/**`, `tests/client/viewmodel.test.ts`, `tests/client/weapon-models.test.ts` |
| E HUD & UI | `src/components/**`, `src/App.tsx`, `src/main.tsx`, `src/styles.css`, `src/lib/{storage,practice,api}.ts`, `index.html`, `tests/client/{mobile-settings,share-invitation}.test.ts`, new `tests/client/hud-*.test.ts` |
| F Audio | `src/game/GameAudio.ts`, new `src/game/audio/**`, `tests/client/game-audio.test.ts` |
| G Effects | `src/game/CombatEffects.ts`, new `src/game/effects/**`, `tests/client/combat-effects.test.ts` |
| H Weapon art | `scripts/blender/{generate_weapons.py,finish_weapons.mjs,validate_weapons.mjs}`, `public/models/weapons-v1.glb`, `art/source/weapons*`, `docs/WEAPONS_ART.md` |
| I Operator art | `scripts/blender/{generate_operator.py,finish_operator.mjs,validate_operator.mjs}` (may import from scout scripts without editing them), `public/models/operator-v1.glb`, `art/source/operator*`, `docs/OPERATOR_ART.md` |
| J Environment art | `scripts/blender/{generate_town_v3.py,finish_town_v3.mjs,validate_town_v3.mjs}`, `public/models/environment-v3*.glb`, `art/source/town-v3/**`, `src/game/{Atmosphere,World,Lightmaps,SunVisibility}.ts`, `scripts/vehicle-test/**`, `src/vehicle-test/**`, `docs/TOWN_V3.md`, `tests/client/{lightmaps,sun-visibility}.test.ts`, `tests/assets/**` |
| K Look | `src/game/{Presentation,RenderQuality}.ts`, `tests/client/{render-tiers,render-quality,presentation}.test.ts` |

Tests owned by nobody above (`tests/client/{assets,game-readiness,preparation-readiness,presentation-physics,deferred-respawns,gait-turn,locomotion-velocity,opponent-locomotion,character-impact,input,touch-gestures,movement-prediction,mobile-assistance,connection}.test.ts`) belong to **C**.

---

## Workstream P: Physics and shared rules

**Files:** `shared/physics.ts`, `shared/map.ts` (helpers only), `tests/shared/*.test.ts`

**Interfaces:** Produces every export listed in the Shared Contract row for `shared/physics.ts` with unchanged signatures. Adds `vaultFireProgress(state: { vault: VaultState | null }, now: number): number` (0..1, 1 when not vaulting) used by A and C to block firing until 0.7.

- [ ] Write tests first for each behaviour below; run `npx tsx --test tests/shared/*.test.ts`.
- [ ] Tune and harden `movePlayer`: ground accel 40 / brake 30 m/s², air control 20% with no air braking, directional speeds (walk 5.0, back 4.0, strafe 4.5), crouch 2.6, ADS × `adsFactor`, sprint 6.9 only forward-ish and never while aiming or firing, dash 8.2 fading to sprint below 20% stamina, stamina 3 s drain / 4 s refill, jump apex ≈ 0.95 m, crouch→stand needs headroom, jump from crouch stands up.
- [ ] Slide: start needs ground, prior sprint, speed ≥ 6, cooldown 600 ms; starts at ≥ 8.8, eases to 3.5 over 800 ms with 1.2 rad/s steering; jump cancels keeping 90%; leaving the ground ends it; ends crouched when crouch held.
- [ ] Vault: add steering (`input.moveX` shifts the crossing point up to ±0.25 m sideways when clear), cancel (crouch rising edge during the first 40% returns to the start with zero velocity), `vaultFireProgress`; verify positives (all lower window sills of both houses, balcony rails, side yard fences 1.64 m, sandbags, barriers, crates, bus hood → bus roof) and negatives (walls, 2.6 m fences, under the truck roof).
- [ ] Grenades: sub-step so no step moves more than 0.08 m (no tunnelling through 0.28 m walls at 20 m/s); rests within 2 s on flat ground; identical trajectories for identical inputs.
- [ ] Performance: add a static uniform grid (2 m cells) over `OBSTACLES` for overlap and ray queries; 8 players × 30 ticks of `movePlayer` plus 8 × 12 `raycastMapDetailed` calls finish in < 15 ms on this machine (test with a generous 60 ms bound).
- [ ] Commit: `Harden shared first-person movement, vaulting and grenade physics`.

## Workstream A: Server rules and rooms

**Files:** `server/engine.ts`, `server/app.ts`, `server/store.ts`, server/acceptance tests listed in ownership.

**Interfaces:** Consumes protocol, weapons, physics, bots (`PracticeBots.input(..., mode)`, `botLoadout`). Produces the engine interface above and per-viewer snapshots.

- [ ] `sanitizeInput`: accept the v3 `InputFrame` exactly (booleans, `streak` null or a `StreakId`, `streakTarget` finite and inside the arena, finite `viewTime`); reject otherwise; slot 1 | 2.
- [ ] Lifecycle: per-player loadout (default `DEFAULT_LOADOUT`; `loadout` message → pending until next spawn); spawn gives 100 health, mags and reserves from the weapon table (+2 mags Deep Pockets), 1 frag (+1 Deep Pockets), slot 1, stand, stamina 1, `readyAt = now + raiseMs`, protection 1.5 s; streak resets on death, unused rewards persist.
- [ ] Movement via `movePlayer` with edges from runtime latches, weapon factors, `canSprint = !cooking && now >= meleeUntil`; publish `aiming`, `sprinting`, `dashing`.
- [ ] Weapons: cadence accumulator (`nextFireAt += interval`, never banking more than one interval of idle time); auto vs press; auto-reload on empty while firing; reload and empty reload; shotgun per-shell reload interruptible by fire; swap cancels reload and waits `raiseMs` (× 0.75 Quick Hands); sprint-to-fire delay after sprinting (× 1.4 after dash); no firing while cooking, knifing, before `readyAt` or before vault progress 0.7; firing ends spawn protection.
- [ ] Hits: eye origin; seeded fixed cones for `hipSpread` / `adsSpread`; shotgun `PELLET_PATTERN` × `pelletSpread`; world via `raycastMapDetailed` (fill `normal`, `surface`); players via `rayHitboxes` at positions rewound to `clamp(viewTime, now - 200, now)` from a 1 s per-tick history (interpolated, including posture); drones via their box; teammates ignored; damage `damageAt` summed per target, rounded; existing simultaneous resolution and tie-breaks preserved.
- [ ] Health: regen after 4 s (2.5 s Second Wind) at 50/s; spawn protection blocks damage.
- [ ] Eliminations: score events and medals (elimination, headshot, long shot ≥ 30 m, first strike, even score, multi-kill within 4 s → double/triple, assists ≥ 20 damage), streak counting (bullet/knife/frag kills only) and rewards at 3/5/7 (`streak` earned events; medals `streak-3/5/7/10`); +1 magazine to the weapon used; a cooking grenade drops live on death.
- [ ] Knife: rising edge, 600 ms, nearest enemy within 2.6 m in a 35° cone with eye-to-eye line of sight at rewound positions, 135 damage, `melee` event, medal `blade`.
- [ ] Frag: cook on press, throw on release (`grenadeLaunch`), explode at `cookingSince + fuseMs` (in hand if still held), `grenade` and `explosion` events, `explosionDamage('frag', d)` to targets with line of sight from the blast to their torso; self damage yes; teammates no (tdm); medal `grenadier`.
- [ ] Rewards: `recon` 20 s; `mortar` needs `streakTarget` inside the arena, three seeded-scatter impacts at `EXPLOSIVES.mortar.delaysMs` on the highest surface under the point; `drone` orbits per `DRONE`, fires every 450 ms at the nearest visible enemy with seeded hit chance `clamp(1.1 - d/45, 0.3, 0.9)`, can be shot down (200 health, `drone-down`); reward kills do not extend streaks.
- [ ] Modes: `create.mode` (`tdm` rejected for ranked); balanced teams for humans and bots; team spawns on the home side; spawn choice prefers points no living enemy can see (eye-to-chest ray), then farthest; win at 15 kills (ffa) or 30 team kills (tdm) or time; `winningTeam`; `RoomSnapshot.mode` and `RoomPlayer.team`; `AvailableGame.mode`.
- [ ] Snapshots: `snapshot(now, viewerId)` → `players` as `PublicPlayerState`, `self` full; positions rounded to 3 decimals, angles to 4, times to integers; `drones`, `recon`, `mortars`, `teamScores`, `scoreLimit`, `mode`. `app.ts` sends one per connection.
- [ ] Tests (rewrite the owned suites): cadence 750 rpm ±1 over 4 s; falloff and zones; rewind hit at 150 ms and miss at 300 ms; regen timing; Second Wind; knife; frag cook/throw/LOS; ammo/reserve/+mag; swap and sprint-to-fire delays; shotgun reload interruption; tdm balance, no friendly fire, team win; spawn visibility; streak rewards and reset; recon/mortar/drone; private fields hidden from other viewers; malformed inputs rejected (Review Focus 4); acceptance suites pass with v3 frames.
- [ ] Commit: `Server rules for first-person combat, team deathmatch and rewards`.

## Workstream B: Bots

**Files:** `server/bots.ts`, `server/navigation.ts`, `tests/server/{bots,bot-platform}.test.ts`

- [ ] New signature (above). Perceive from `eyePosition`; ignore teammates; aim at torso (Challenging: 35% head); v3 frame fields with `viewTime = now`.
- [ ] Loadouts via `botLoadout` (shared/weapons.ts): Scout assault, Moxie close, Rook assault (Challenging: marksman); switch to secondary when the primary is empty and an enemy is within 10 m; reload when hidden.
- [ ] Retreat to regenerate below 45 health (replaces healing); dash on long unengaged routes (Balanced/Challenging); occasional slide into engagements (Challenging); knife within 1.6 m; frag at a last-seen enemy behind cover 8–25 m away (Balanced 15% / Challenging 30% per opportunity, 8 s cooldown); use rewards (recon now, mortar at last-seen enemy, drone now).
- [ ] Navigation still covers both houses, all stair routes and the truck with the 8 new cover boxes.
- [ ] Tests: no teammate targeting; eye-height aim convergence; retreat; bounded grenade use; difficulty ordering; full practice rounds at all difficulties without exceptions.
- [ ] Commit: `Bots for first-person rules, teams and rewards`.

## Workstream C: Client first-person core

**Files:** see ownership. **Consumes** every contract file; **produces** the GameView and InputController interfaces above.

- [ ] Camera: eye of the predicted posture with smoothing; FOV from settings (horizontal → vertical by aspect) ÷ `adsZoom` blended by ADS; sprint +4°; landing dip from `landedSpeed`; bob (off with `reduceMotion`); slide roll 4°; vault dip.
- [ ] Prediction: `MovementPrediction` replays `movePlayer` with the server's context rules (edges, weapon factors, `canSprint`); reconcile to `snapshot.self`.
- [ ] `LocalWeapon`: mirror cadence, ammo, reloads, swap, sprint-to-fire and vault-fire rules for presentation; on a predicted shot call `ViewModel.fire()`, `GameAudio.shot(local)`, apply recoil via `InputController.addViewKick` (pattern from `WEAPONS[*].recoil`, ADS factor, partial recovery after release), local tracer to the crosshair contact. Server ammo wins once acknowledged.
- [ ] Feedback: hit markers from own `shot` traces (`head` zone → head) and `elimination` (kill); damage arcs from `damage.from`; flinch on damage (× 0.6 Steady Aim); low-health audio and `Presentation.setCondition`.
- [ ] Remote players: operator model with team colour (tdm friendly `#4aa3ff`, enemy `#ff5a4f`; ffa player colour) on `PlayerAccent`; weapon from `WeaponLibrary.weapon(id,'world')` on `weapon_socket` (fallback `hand_r`); crouch/slide/vault poses (clips when present, procedural pelvis/leg bend otherwise); friendly name tags always, enemy tags only under the crosshair when visible; no enemy health bars.
- [ ] Rendering: world through `ArenaPresentation` (overlay via `setOverlay` when `drawsOverlay`), otherwise world then viewmodel with depth cleared; viewmodel projection follows the world camera.
- [ ] Effects and audio wiring per the contract (shots, impacts and bullet holes from traces, grenade trajectories and bounces, explosions with camera shake, drones via `CombatEffects.setDrones`, mortar whistles, breakables from `world.breakables`, listener pose, footsteps by `surfaceAt` and speed with Quiet Step at 0.3 loudness, landing, slide, vault, reload steps at 25/60/85%, ADS, swap, rewards, medals).
- [ ] HUD: publish `HudFrame` ≤ 30 Hz including minimap blips (teammates; enemies during my team's recon unless Low Profile; firing pings for 2 s unless Low Profile; drones; mortar targets; grenades) and `hud.clear()` on dispose.
- [ ] Input: InputController v3 (double-tap sprint within 300 ms = dash while held; hold/toggle modes; wheel / Q swap; 1/2; V knife; G cook/throw; 4 uses the oldest reward; mortar targeting via HUD; Escape cancels targeting; view kicks bounded to the pitch limits) and TouchGestures roles; stick pushed past 95% forward sprints (auto sprint mode), a second push within 300 ms dashes.
- [ ] `AutomaticFire`/`reticleTarget` use eye origin and hitboxes.
- [ ] `connection.ts`: `events` 128, `feed` 40.
- [ ] Tests: update the owned client suites; add replay-parity tests (prediction vs `movePlayer` for slide→jump→vault chains), `LocalWeapon` parity with the weapon table, hit-marker/arc derivation, touch roles.
- [ ] Commit: `First-person client: camera, prediction, local fire and HUD feed`.

## Workstream D: Viewmodel and weapon library

**Files:** see ownership.

- [ ] `loadWeaponModels`: parse `ARENA_ASSETS.weapons` (meshopt + `ktx2Loader`), map nodes by the GLB contract, clone per use, procedural stand-ins for any missing node (all ids must always work), `fromAsset` flag, dispose.
- [ ] `ViewModel`: arms on the grips; layered procedural motion — breathing, look sway (spring, clamped), stride bob, sprint and dash poses, crouch offset, slide tilt, jump/land spring, ADS alignment of the `sight` anchor to the camera axis, recoil (back, up, roll × `recoil.visual`), reload choreography by progress (magazine out and in; per-shell for the shotgun; bolt for the Longbow), raise/lower, wall retract, grenade cook and throw, knife swing, vault tuck; muzzle flash mesh, smoke kept clear of screen centre while aiming, shell ejection; hidden when scoped; lighting that follows the world sun relative to the camera; scene environment from the world.
- [ ] Tests: switching weapons; sight on axis within 1 mm at full ADS; recoil decays; reload moves the magazine mid-way and restores at 1; scoped hides; fallback covers all ids; `muzzleWorld` maps through the camera.
- [ ] Commit: `First-person viewmodel with procedural weapon handling`.

## Workstream E: HUD, menus, touch layout and settings

**Files:** see ownership.

- [ ] Original tactical HUD: minimap (top left, rotating, drawn from `OBSTACLES`, blips from `HudFrame`), score and clock (team bar in tdm), kill feed with weapon icons and headshot marks, hit markers, per-weapon crosshairs from `HudFrame.crosshair`, scope overlay, damage arcs, low-health vignette, grenade warnings, ammo panel, health bar (shown below 100), stamina pip, reward tray with key hint and mortar targeting map, score pop-ups, medals, "eliminated by" card, scoreboard with teams and K/D/A, results with team result and top scorer.
- [ ] Loadout picker (three presets plus custom: primary with stat bars, one perk per slot) in the lobby, pause menu and while dead; sends `{ type: 'loadout' }`; persisted in settings.
- [ ] Create match: Free-for-all or Team Deathmatch (ranked forces free-for-all); lobby shows teams; Available Games shows the mode.
- [ ] Touch layout for first person: stick (sprint indicator), look area, Fire right, Fire left, Aim, Crouch/Slide, Jump/Vault, Reload, Grenade (hold), Knife, Swap, Reward; landscape, safe areas, ≥ 44 px targets.
- [ ] Settings: field of view, aim sensitivity, hold/toggle aim and crouch, sprint mode, reduce motion; Help with the new controls.
- [ ] Tests: settings defaults/clamps and loadout persistence; pure HUD helpers.
- [ ] Commit: `Tactical HUD, loadouts, team mode menus and first-person touch layout`.

## Workstream F: Audio

- [ ] Procedural Web Audio behind the contract methods: layered per-weapon gun voices, generated impulse-response tails (indoor room / outdoor slapback), distance low-pass and speed-of-sound delay, HRTF panning on desktop and equal-power on phones, occlusion low-pass; surface footsteps; landing, slide, vault, reload, aim, swap, dry fire, knife; hit, head and kill markers; damage and low-health heartbeat with master low-pass; grenade pin, bounce and explosions; mortar whistle; drone loop; reward, medal and countdown cues; ambience bed.
- [ ] 32-voice cap with oldest-voice stealing; nodes always disconnected; never throws without a context; iPhone unlock flow unchanged.
- [ ] Tests with a fake `AudioContext`: every method safe without a context; nodes cleaned up; voice cap; volume 0 mutes; dispose closes.
- [ ] Commit: `Procedural combat audio`.

## Workstream G: Combat effects

- [ ] Remote muzzle flashes and smoke, pooled muzzle/explosion lights (`muzzleLight` tier), tracers (as requested by the caller), surface impacts (concrete/asphalt dust and chips, wood splinters, metal sparks, grass dirt, sandbag sand, glass shards, players dark puff, protected target shimmer), bullet-hole decals (ring buffer of `tier.decals`, procedural atlas), shells, explosions (flash, fireball, smoke, debris, scorch decal, dust ring), grenades in flight, drones (`setDrones(drones, serverTime)`: quadcopter with spinning rotors and a light, interpolated), breakables (glass and pots hide and shatter when a tracer segment crosses their bounds), subtle elimination dust.
- [ ] Batched, allocation-free per shot; phone budgets halved.
- [ ] Tests: capacities, decal ring buffer, tracer flag, breakable detection, explosion counts, degenerate input, dispose.
- [ ] Commit: `Combat effects: impacts, decals, explosions, drones and breakables`.

## Workstream H: Weapon and arms art

- [ ] `generate_weapons.py` (run through `scripts/blender/run_blender.mjs`) builds original models per the spec and GLB contract with baked PBR textures and wear; `finish_weapons.mjs` (KTX2 via `C:\it\tools\ktx\bin`, meshopt) writes `public/models/weapons-v1.glb` (≤ 6 MB, ≤ 12k triangles per weapon, ≤ 8k per arm); `validate_weapons.mjs` checks node names and anchors, bounds, triangle counts and size; preview render in `art/source/`.
- [ ] Report the npm scripts to add (`weapons:generate`, `weapons:finish`, `weapons:validate`).
- [ ] Commit: `Original weapon and arm models for the first-person view`.

## Workstream I: Operator character art

- [ ] Re-skin the scout as a modern military operator per the GLB contract; keep rig, clips and CMU credits; `PlayerAccent` on armband and patches; remove weapon meshes; add `weapon_socket`; author `Crouch`, `CrouchWalk`, `Slide` clips if feasible; ≤ 4 MB, ≤ 25k triangles; finish, validate, preview renders.
- [ ] Commit: `Operator character re-skin with weapon socket and crouch clips`.

## Workstream J: Environment art and light

- [ ] `generate_town_v3.py`: the v2 town re-dressed as a military checkpoint (spec §6) with render geometry for the 8 new cover boxes at their exact positions, cargo-truck and bus re-skins in the same footprints, one burnt-out car, decorative props only where they cannot be walked into, `Breakable_Glass_*` panes in window openings and a few `Breakable_Pot_*`, distant smoke cards.
- [ ] Golden-hour re-bake (low warm sun, long shadows across the street, cool shade, haze) calibrated as in v2; update `Atmosphere.ts` constants and sky to match; full ≤ 30 MB, phone ≤ 14 MB; validation of collision alignment; before/after captures with the vehicle-test harness.
- [ ] Commit: `Kannon Town v3: military checkpoint dressing and golden-hour bake`.

## Workstream K: Look

- [ ] `ArenaPresentation`: viewmodel overlay pass (depth cleared, before bloom and grade; `drawsOverlay = true`), aim depth of field that keeps the aim point sharp, condition grading (low-health desaturation and red edges, flash white-out), gritty filmic grade (saturation ~0.9, split toning, S-curve, subtle animated grain, vignette, slight edge chromatic aberration on High only), bloom tuned for flashes and explosions; desktop 1080p stays ≥ 60 fps here.
- [ ] Tests: tier mapping, uniforms in range, overlay flag, disposal.
- [ ] Commit: `Gritty presentation grade, aim depth of field and viewmodel pass`.

---

## Integration (lead, after all workstreams)

- [ ] Merge P, A, B, C, D, F, G, K, E, H, I, J in that order; resolve conflicts; apply `contractRequests`.
- [ ] `npm run typecheck`, `npm test`, `npm run test:assets` (with new validators), `npm run build`.
- [ ] Add npm scripts reported by art workstreams; update `README.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCT_BRIEF.md`, `docs/DESIGN.md`, `docs/RELEASE.md`.
- [ ] Adversarial review workflow; fix; browser play-tests (desktop and touch emulation) including a bot match and a two-browser TDM match.
- [ ] Coastline test copy (separate directory, Compose project and port), then production deploy, `/health` check and a live match.
