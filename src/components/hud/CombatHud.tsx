import { useEffect, type CSSProperties } from 'react';
import type { Loadout, StreakId } from '../../../shared/protocol';
import { STREAKS, WEAPONS } from '../../../shared/weapons';
import type { HudFrame, HudStore } from '../../game/hud';
import type { InputController } from '../../game/InputController';
import { Icon } from '../Icon';
import { STREAK_ICONS, WEAPON_ICONS } from '../labels';
import { MARKER_MS, ammoLevel, arcOpacity, cookState, crosshairRing, crosshairStyle, crosshairTicks, fadeOut, grenadeAlert, healthBarVisible, lowHealthLevel, staminaVisible, streakProgress } from './combat';
import { useHudFrame } from './hooks';
import { Minimap, MortarTargetMap } from './Minimap';
import { rectStyle, type Rect } from './touchLayout';

export interface CombatHudProps {
  hud: HudStore; input: InputController | null; touch: boolean;
  /** Alive and playing: draw the crosshair and combat feedback. */
  live: boolean;
  /** Countdown and play: draw the minimap, health and ammo. */
  status: boolean;
  autoTarget: boolean; streak: number; loadout?: Loadout;
  minimap: { size: number; range: number };
  /** Touch layout slot for the health and ammo panel. */
  statusRect?: Rect;
}

/** Everything drawn from the per-frame HUD feed. Re-renders at the feed rate, so it stays small. */
export function CombatHud({ hud, input, touch, live, status, autoTarget, streak, loadout, minimap, statusRect }: CombatHudProps) {
  const frame = useHudFrame(hud);
  const targeting = !!frame?.mortarTargeting && live;
  useEffect(() => {
    if (!targeting || !input) return;
    // The map needs a free cursor on desktop; Escape still cancels.
    if (document.pointerLockElement) document.exitPointerLock();
    const key = (event: KeyboardEvent) => { if (event.code === 'Escape') input.setStreakTarget(null); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [targeting, input]);
  if (!frame) return null;
  const finishTargeting = (target: { x: number; z: number } | null) => {
    input?.setStreakTarget(target);
    if (!touch) void input?.requestPointerLock();
  };
  const vignette = live ? lowHealthLevel(frame.health) : 0;
  return <>
    {live && frame.scoped && <ScopeOverlay/>}
    {vignette > 0 && <div className="health-vignette" style={{ opacity: vignette }} aria-hidden="true"/>}
    {live && <Reticle frame={frame} autoTarget={autoTarget}/>}
    {status && <Minimap frame={frame} size={minimap.size} range={minimap.range}/>}
    {status && <StatusPanel frame={frame} touch={touch} streak={streak} loadout={loadout} rect={statusRect}/>}
    {status && !touch && frame.rewards.length > 0 && <RewardTray rewards={frame.rewards}/>}
    {targeting && <MortarTargetMap frame={frame} touch={touch} onTarget={target => finishTargeting(target)} onCancel={() => finishTargeting(null)}/>}
  </>;
}

function ScopeOverlay() {
  return <div className="scope-overlay" aria-hidden="true"><div className="scope-lens"><i className="scope-line scope-h"/><i className="scope-line scope-v"/><i className="scope-post scope-left"/><i className="scope-post scope-right"/><i className="scope-post scope-bottom"/><b/></div></div>;
}

function Reticle({ frame, autoTarget }: { frame: HudFrame; autoTarget: boolean }) {
  const spec = WEAPONS[frame.weapon];
  const style = crosshairStyle(spec?.kind ?? 'ar');
  const gap = frame.scoped ? 0 : frame.crosshair;
  const ticks = crosshairTicks(style, gap), ring = crosshairRing(style, gap);
  const cook = cookState(frame.cook);
  const circumference = 2 * Math.PI * 26;
  return <div className="hud-reticle" aria-hidden="true">
    {ticks.length > 0 && <div className={`crosshair-v3 crosshair-${style} ${frame.blocked ? 'blocked' : ''} ${autoTarget ? 'auto-target' : ''}`}>
      {ring > 0 && <span className="crosshair-ring" style={{ width: ring * 2, height: ring * 2, left: -ring, top: -ring }}/>}
      {ticks.map((tick, index) => <i key={index} style={{ left: tick.x, top: tick.y, width: tick.w, height: tick.h }}/>)}
      <b className="crosshair-dot"/>
    </div>}
    {frame.hitMarkers.map(marker => {
      const alpha = fadeOut(frame.time, marker.at, MARKER_MS[marker.kind]);
      return alpha > 0 && <div key={marker.id} className={`hit-marker hit-${marker.kind}`} style={{ opacity: alpha, transform: `scale(${(0.9 + 0.3 * alpha).toFixed(3)})` }}><i/><i/><i/><i/></div>;
    })}
    {frame.damageArcs.map(arc => {
      const alpha = arcOpacity(frame.time, arc.at, arc.amount);
      return alpha > 0 && <div key={arc.id} className="damage-arc" style={{ opacity: alpha, transform: `rotate(${arc.angle.toFixed(4)}rad)` }}><i/></div>;
    })}
    {frame.grenades.map(grenade => <div key={grenade.id} className="grenade-warning" style={{ transform: `rotate(${grenade.angle.toFixed(4)}rad)`, opacity: grenadeAlert(grenade.distance) }}>
      <span style={{ transform: `translate(-50%, -50%) rotate(${(-grenade.angle).toFixed(4)}rad)` }}><Icon name="grenade" size={20}/><small>{Math.round(grenade.distance)} m</small></span>
    </div>)}
    {cook.active && <div className={`cook-ring ${cook.danger ? 'danger' : ''}`}>
      <svg viewBox="-30 -30 60 60" width="60" height="60"><circle r="26"/><circle className="cook-progress" r="26" transform="rotate(-90)" strokeDasharray={`${(circumference * cook.progress).toFixed(1)} ${circumference.toFixed(1)}`}/></svg>
      <span>{cook.danger ? 'Throw!' : 'Cooking'}</span>
    </div>}
    {staminaVisible(frame.stamina, frame.dashing) && <div className={`stamina-pip ${frame.dashing ? 'dashing' : ''}`}><i style={{ transform: `scaleX(${Math.max(0, Math.min(1, frame.stamina)).toFixed(3)})` }}/></div>}
  </div>;
}

function StatusPanel({ frame, touch, streak, loadout, rect }: { frame: HudFrame; touch: boolean; streak: number; loadout?: Loadout; rect?: Rect }) {
  const spec = WEAPONS[frame.weapon];
  const level = ammoLevel(frame.mag, spec?.magazine ?? 30);
  const progress = streakProgress(streak);
  const health = Math.max(0, Math.ceil(frame.health));
  const position: CSSProperties | undefined = touch && rect ? rectStyle(rect) : undefined;
  return <div className={`hud-status ${touch ? 'touch' : ''}`} style={position}>
    <div className={`health-panel ${healthBarVisible(frame.health) ? 'shown' : ''} ${frame.health < 35 ? 'critical' : ''}`} aria-label={`Health ${health}`}>
      <strong>{health}</strong><div className="health-track"><i style={{ transform: `scaleX(${Math.max(0, Math.min(1, frame.health / 100)).toFixed(3)})` }}/></div>
    </div>
    <div className={`ammo-panel ammo-${level}`}>
      <div className="ammo-weapon"><Icon name={WEAPON_ICONS[frame.weapon] ?? 'ar'} size={touch ? 26 : 34}/><span>{spec?.name ?? 'Weapon'}</span></div>
      <div className="ammo-count" aria-label={`${frame.mag} rounds, ${frame.reserve} spare`}><strong>{frame.mag}</strong><span>/ {frame.reserve}</span></div>
      <div className="ammo-extras">
        <span className="ammo-frags" aria-label={`${frame.frags} frag grenades`}><Icon name="grenade" size={15}/>×{frame.frags}</span>
        {loadout && !touch && <span className="ammo-slots">{([1, 2] as const).map(slot => <b key={slot} className={frame.slot === slot ? 'active' : ''}>{slot} {WEAPONS[slot === 1 ? loadout.primary : loadout.secondary].name}</b>)}</span>}
        <span className="streak-pips" aria-label={progress.next ? `${progress.remaining} more for ${progress.next.name}` : 'All rewards earned this life'}>
          {Array.from({ length: 7 }, (_, index) => <i key={index} className={`${index < progress.streak ? 'on' : ''} ${progress.marks.some(mark => mark.kills === index + 1) ? 'mark' : ''}`}/>)}
        </span>
      </div>
      {frame.reload >= 0 && <div className="ammo-reload"><b><i style={{ transform: `scaleX(${Math.max(0, Math.min(1, frame.reload)).toFixed(3)})` }}/></b><span>Reloading</span></div>}
      {frame.reload < 0 && level === 'empty' && <span className="ammo-hint">{frame.reserve > 0 ? (touch ? 'Tap Reload' : 'Press R to reload') : touch ? 'Out of ammo · tap Swap' : 'Out of ammo · press Q'}</span>}
    </div>
  </div>;
}

function RewardTray({ rewards }: { rewards: StreakId[] }) {
  return <div className="reward-tray" aria-label="Earned rewards">{rewards.map((reward, index) =>
    <div key={`${reward}-${index}`} className={`reward-chip ${index === 0 ? 'next' : ''}`}><Icon name={STREAK_ICONS[reward]} size={22}/><span>{STREAKS[reward].name}</span>{index === 0 && <kbd>4</kbd>}</div>)}
  </div>;
}
