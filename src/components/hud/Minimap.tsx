import { memo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { EXPLOSIVES } from '../../../shared/weapons';
import type { HudFrame, MinimapBlip } from '../../game/hud';
import { Icon } from '../Icon';
import { ARENA_MAP, clampToFrame, headingOnMinimap, mapToArena, minimapRects, minimapTransform, northOnMinimap, toMinimap, type MapView } from './mapGeometry';

const RECTS = minimapRects();
/** Static map geometry in world metres; drawn once and only transformed afterwards. */
const MapGeometry = memo(function MapGeometry() {
  return <g className="mm-geometry">{RECTS.map(rect => <rect key={rect.id} className={`mm-${rect.kind}`} x={rect.x} y={rect.z} width={rect.w} height={rect.d}/>)}</g>;
});
const ARROW = 'M0 -1.25 L0.95 1 L0 0.5 L-0.95 1 Z';
const FRAG_LETHAL = EXPLOSIVES.frag.lethal, MORTAR_LETHAL = EXPLOSIVES.mortar.lethal;

/** One blip at a map position (metres); `px` is metres per CSS pixel so glyphs keep their screen size. */
function Blip({ blip, x, y, heading, px }: { blip: MinimapBlip; x: number; y: number; heading: number | null; px: number }) {
  const fade = Math.max(0, Math.min(1, blip.fade));
  const at = `translate(${x.toFixed(2)} ${y.toFixed(2)})`;
  switch (blip.kind) {
    case 'friend': case 'enemy':
      return heading === null
        ? <circle className={`mm-${blip.kind}`} cx={x} cy={y} r={3.4 * px}/>
        : <path className={`mm-${blip.kind}`} d={ARROW} transform={`${at} rotate(${(heading * 180 / Math.PI).toFixed(1)}) scale(${(5 * px).toFixed(3)})`}/>;
    case 'ping':
      return <g className="mm-ping" transform={at} opacity={Math.max(0.2, fade)}><circle r={3 * px}/><circle className="mm-ping-ring" r={(4 + 6 * (1 - fade)) * px}/></g>;
    case 'drone':
      return <g className="mm-drone" transform={`${at} scale(${(4.2 * px).toFixed(3)})`}><path d="M-1 -1 1 1M1 -1 -1 1"/><circle r="0.42"/></g>;
    case 'mortar':
      return <g className="mm-mortar" transform={at} opacity={Math.max(0.35, fade)}><circle r={MORTAR_LETHAL}/><path d={`M${-MORTAR_LETHAL} 0H${MORTAR_LETHAL}M0 ${-MORTAR_LETHAL}V${MORTAR_LETHAL}`}/></g>;
    case 'grenade':
      return <g className="mm-grenade" transform={at} opacity={Math.max(0.4, fade)}><circle r={FRAG_LETHAL}/><circle className="mm-grenade-dot" r={2 * px}/></g>;
  }
}

/** Rotating minimap: you at the centre facing up; teammates, pings and rewards from the HUD feed. */
export function Minimap({ frame, size, range }: { frame: HudFrame; size: number; range: number }) {
  const view: MapView = frame.view;
  const px = 2 * range / size, edge = range - 4 * px;
  const north = northOnMinimap(view.yaw), northAt = range - 7 * px;
  return <div className={`minimap ${frame.reconActive ? 'recon-on' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
    <svg className="minimap-svg" viewBox={`${-range} ${-range} ${2 * range} ${2 * range}`} width={size} height={size}>
      <g transform={minimapTransform(view)}><MapGeometry/></g>
      {frame.blips.map((blip, index) => {
        const point = blip.kind === 'mortar' || blip.kind === 'grenade' ? { ...toMinimap(view, blip.x, blip.z), clamped: false } : clampToFrame(toMinimap(view, blip.x, blip.z), edge);
        if ((blip.kind === 'mortar' || blip.kind === 'grenade') && Math.max(Math.abs(point.u), Math.abs(point.v)) > range + 8) return null;
        const heading = blip.yaw === undefined || point.clamped ? null : headingOnMinimap(view.yaw, blip.yaw);
        return <Blip key={`${blip.kind}-${index}`} blip={blip} x={point.u} y={point.v} heading={heading} px={px}/>;
      })}
      <path className="mm-self" d={ARROW} transform={`scale(${(6 * px).toFixed(3)})`}/>
      <text className="mm-north" x={north.u * northAt} y={north.v * northAt} fontSize={10 * px} dominantBaseline="central" textAnchor="middle">N</text>
    </svg>
    {frame.reconActive && <span className="minimap-tag">Recon</span>}
  </div>;
}

/** North-up arena map for choosing where the Mortar Volley lands. */
export function MortarTargetMap({ frame, touch, onTarget, onCancel }: { frame: HudFrame; touch: boolean; onTarget: (target: { x: number; z: number }) => void; onCancel: () => void }) {
  const svg = useRef<SVGSVGElement>(null);
  const [aim, setAim] = useState<{ x: number; z: number } | null>(null);
  const pick = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = svg.current?.getBoundingClientRect();
    return bounds ? mapToArena(event.clientX - bounds.left, event.clientY - bounds.top, bounds.width, bounds.height) : null;
  };
  const { view } = frame;
  return <div className="mortar-overlay" role="dialog" aria-modal="true" aria-label="Choose where the Mortar Volley lands">
    <div className="mortar-panel">
      <div className="mortar-heading"><Icon name="mortar" size={26}/><div><strong>Mortar Volley</strong><span>{touch ? 'Tap the map to call it in.' : 'Click the map to call it in. Esc cancels.'}</span></div>
        <button type="button" className="button secondary small" onClick={onCancel}>Cancel</button></div>
      <svg ref={svg} className="mortar-map" viewBox={`${-ARENA_MAP.x} ${-ARENA_MAP.z} ${2 * ARENA_MAP.x} ${2 * ARENA_MAP.z}`} role="img" aria-label="Kannon Town map"
        onPointerMove={event => { if (event.pointerType === 'mouse') setAim(pick(event)); }} onPointerLeave={() => setAim(null)}
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); const target = pick(event); if (target) onTarget(target); }}>
        <MapGeometry/>
        {frame.blips.filter(blip => blip.kind === 'friend' || blip.kind === 'enemy' || blip.kind === 'mortar').map((blip, index) =>
          <circle key={index} className={`mm-${blip.kind} map-dot`} cx={blip.x} cy={blip.z} r={blip.kind === 'mortar' ? MORTAR_LETHAL : 1.1}/>)}
        <path className="mm-self" d={ARROW} transform={`translate(${view.x.toFixed(2)} ${view.z.toFixed(2)}) rotate(${(view.yaw * 180 / Math.PI).toFixed(1)}) scale(1.4)`}/>
        {aim && <g className="mortar-aim" transform={`translate(${aim.x} ${aim.z})`}><circle r={MORTAR_LETHAL}/><circle r={EXPLOSIVES.mortar.radius} className="mortar-aim-outer"/><path d="M-1.2 0H1.2M0 -1.2V1.2"/></g>}
      </svg>
    </div>
  </div>;
}
