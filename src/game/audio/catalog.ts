import type { StreakId, SurfaceKind } from '../../../shared/protocol';
import { renderExplosion, renderFlyby, renderWhistle, EXPLOSION_KINDS, type ExplosionKind } from './blasts';
import { renderCountdown, renderDamage, renderHeartbeat, renderMarker, renderMedal, renderRing, renderStreak, type MarkerKind } from './cues';
import { createRng, filterChain, hashSeed, normalize, type Rng } from './dsp';
import { renderAim, renderDry, renderMelee, renderPin, renderReload, renderRespawn, renderSwap, renderVault, RELOAD_SIZES, type ReloadSize } from './foley';
import { CASING_KINDS, GUN_VOICES, renderCasing, renderCycle, renderGunCore, renderGunFar, type CasingKind, type GunVoice } from './guns';
import { renderBounce, renderGear, renderImpact, renderLand, renderSlide, renderStep, SURFACES, type ImpactKind } from './surfaces';

/** Every procedural sound, by name. Names are stable so each variant always renders identically. */
export type SoundKey =
  | `gun:${GunVoice}` | `far:${GunVoice}` | 'cycle:pump' | 'cycle:bolt' | `casing:${CasingKind}`
  | `step:${SurfaceKind}` | 'gear' | 'land' | 'slide:hard' | 'slide:soft' | `impact:${ImpactKind}` | 'bounce:hard' | 'bounce:soft'
  | `reload:${'mag-out' | 'mag-in' | 'bolt' | 'shell'}:${ReloadSize}` | 'aim:in' | 'aim:out' | 'swap' | 'dry'
  | 'melee:swing' | 'melee:hit' | 'vault' | 'pin' | 'respawn'
  | `explosion:${ExplosionKind}` | 'whistle' | 'flyby'
  | `ui:${MarkerKind}` | 'ui:damage' | 'ui:heartbeat' | 'ui:ring' | `streak:${'earned' | 'used'}:${StreakId}` | 'medal'
  | 'countdown:tick' | 'countdown:final' | 'wind' | 'noise';

export interface SoundRecipe {
  /** Variants rendered on desktop and on phones (fewer, to save memory and start-up time). */
  variants: number; phoneVariants: number;
  /** Rendered at half the device rate: content stays well below 10 kHz, so half the work and memory. */
  half: boolean;
  render(sampleRate: number, rng: Rng, variant: number): Float32Array;
}

const recipe = (variants: number, phoneVariants: number, half: boolean, render: SoundRecipe['render']): SoundRecipe => ({ variants, phoneVariants, half, render });

/** Four seconds of gusting wind that loops without a seam: brown and pink noise, the last quarter
 * second crossfaded into the start. */
export const WIND_SECONDS = 4;
function renderWind(sampleRate: number, rng: Rng): Float32Array {
  const n = Math.ceil(WIND_SECONDS * sampleRate), fade = Math.round(0.25 * sampleRate), raw = new Float32Array(n + fade);
  let brown = 0;
  for (let i = 0; i < raw.length; i++) { brown = 0.985 * brown + 0.015 * (rng() * 2 - 1); raw[i] = brown * 6 + (rng() * 2 - 1) * 0.12; }
  filterChain(raw, sampleRate, [['lowpass', 900], ['highpass', 40]]);
  const out = raw.slice(0, n);
  for (let i = 0; i < fade; i++) { const u = i / fade; out[i] = raw[i] * Math.sqrt(u) + raw[n + i] * Math.sqrt(1 - u); }
  return normalize(out, 0.6);
}

/** One second of white noise, looped under the drone's rotor buzz and the helicopter's blades. */
function renderNoise(sampleRate: number, rng: Rng): Float32Array {
  const out = new Float32Array(Math.ceil(sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = rng() * 2 - 1;
  return normalize(out, 0.5);
}

export function recipeFor(key: SoundKey): SoundRecipe {
  const [group, a, b] = key.split(':') as [string, string, string | undefined];
  switch (group) {
    case 'gun': return recipe(3, 2, false, (fs, rng) => renderGunCore(a as GunVoice, fs, rng));
    case 'far': return recipe(1, 1, true, (fs, rng) => renderGunFar(a as GunVoice, fs, rng));
    case 'cycle': return recipe(1, 1, false, (fs, rng) => renderCycle(a as 'pump' | 'bolt', fs, rng));
    case 'casing': return recipe(3, 2, false, (fs, rng) => renderCasing(a as CasingKind, fs, rng));
    case 'step': return recipe(4, 3, false, (fs, rng, variant) => renderStep(a as SurfaceKind, fs, rng, variant));
    case 'gear': return recipe(3, 2, false, (fs, rng) => renderGear(fs, rng));
    case 'land': return recipe(2, 1, false, (fs, rng) => renderLand(fs, rng));
    case 'slide': return recipe(2, 1, false, (fs, rng) => renderSlide(a as 'hard' | 'soft', fs, rng));
    case 'impact': return recipe(3, 2, false, (fs, rng, variant) => renderImpact(a as ImpactKind, fs, rng, variant));
    case 'bounce': return recipe(3, 2, false, (fs, rng) => renderBounce(a as 'hard' | 'soft', fs, rng));
    case 'reload': return recipe(2, 1, false, (fs, rng) => renderReload(a as 'mag-out' | 'mag-in' | 'bolt' | 'shell', b as ReloadSize, fs, rng));
    case 'aim': return recipe(2, 1, false, (fs, rng) => renderAim(a === 'in', fs, rng));
    case 'swap': return recipe(2, 1, false, (fs, rng) => renderSwap(fs, rng));
    case 'dry': return recipe(1, 1, false, (fs, rng) => renderDry(fs, rng));
    case 'melee': return recipe(a === 'swing' ? 3 : 2, a === 'swing' ? 2 : 1, false, (fs, rng) => renderMelee(a as 'swing' | 'hit', fs, rng));
    case 'vault': return recipe(2, 1, false, (fs, rng) => renderVault(fs, rng));
    case 'pin': return recipe(1, 1, false, (fs, rng) => renderPin(fs, rng));
    case 'respawn': return recipe(1, 1, false, (fs, rng) => renderRespawn(fs, rng));
    case 'explosion': return recipe(2, 1, false, (fs, rng) => renderExplosion(a as ExplosionKind, fs, rng));
    case 'whistle': return recipe(1, 1, true, (fs, rng) => renderWhistle(fs, rng));
    case 'flyby': return recipe(3, 2, false, (fs, rng) => renderFlyby(fs, rng));
    case 'ui':
      if (a === 'damage') return recipe(2, 1, true, (fs, rng) => renderDamage(fs, rng));
      if (a === 'heartbeat') return recipe(1, 1, true, (fs, rng) => renderHeartbeat(fs, rng));
      if (a === 'ring') return recipe(1, 1, false, (fs, rng) => renderRing(fs, rng));
      return recipe(1, 1, false, (fs, rng) => renderMarker(a as MarkerKind, fs, rng));
    case 'streak': return recipe(1, 1, false, (fs, rng) => renderStreak(a as 'earned' | 'used', b as StreakId, fs, rng));
    case 'medal': return recipe(1, 1, false, (fs, rng) => renderMedal(fs, rng));
    case 'countdown': return recipe(1, 1, false, (fs, rng) => renderCountdown(a === 'final', fs, rng));
    case 'wind': return recipe(1, 1, true, (fs, rng) => renderWind(fs, rng));
    case 'noise': return recipe(1, 1, true, (fs, rng) => renderNoise(fs, rng));
  }
  throw new Error(`Unknown sound ${key}`);
}

/** Renders one variant of a sound at the given rate (already halved for `half` recipes). */
export function renderSound(key: SoundKey, sampleRate: number, variant = 0): Float32Array {
  return recipeFor(key).render(sampleRate, createRng(hashSeed(`${key}#${variant}`)), variant);
}

const STREAKS: readonly StreakId[] = ['recon', 'mortar', 'drone'];
/** Every sound name, for warm-up lists and tests. */
export const ALL_SOUNDS: readonly SoundKey[] = [
  ...GUN_VOICES.map(v => `gun:${v}` as const), ...GUN_VOICES.map(v => `far:${v}` as const), 'cycle:pump', 'cycle:bolt',
  ...CASING_KINDS.map(k => `casing:${k}` as const), ...SURFACES.map(s => `step:${s}` as const), 'gear', 'land', 'slide:hard', 'slide:soft',
  ...[...SURFACES, 'flesh' as const].map(s => `impact:${s}` as const), 'bounce:hard', 'bounce:soft',
  ...(['mag-out', 'mag-in', 'bolt', 'shell'] as const).flatMap(step => RELOAD_SIZES.map(size => `reload:${step}:${size}` as const)),
  'aim:in', 'aim:out', 'swap', 'dry', 'melee:swing', 'melee:hit', 'vault', 'pin', 'respawn',
  ...EXPLOSION_KINDS.map(k => `explosion:${k}` as const), 'whistle', 'flyby',
  'ui:hit', 'ui:head', 'ui:kill', 'ui:damage', 'ui:heartbeat', 'ui:ring',
  ...(['earned', 'used'] as const).flatMap(kind => STREAKS.map(reward => `streak:${kind}:${reward}` as const)), 'medal',
  'countdown:tick', 'countdown:final', 'wind', 'noise',
];
