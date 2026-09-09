import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RULES, type GameEvent } from '../../shared/protocol';
import type { ArenaConnection } from '../lib/connection';
import type { PlayerSession, Settings } from '../lib/storage';
import { GameView } from '../game/GameView';
import { InputController } from '../game/InputController';
import { GyroscopeInput } from '../game/Gyroscope';
import { PreparationReadiness, type ReadinessState } from '../game/PreparationReadiness';
import { Loadout } from './Loadout';
import { Icon } from './Icon';
import { TouchControls } from './TouchControls';
import { SettingsDialog } from './SettingsDialog';
import { practiceLevelName } from '../lib/practice';

function clock(seconds: number) { const n = Math.max(0, Math.ceil(seconds)); return `${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`; }

export default function GameScreen({ connection, settings, setSettings, player, onLeave }: { connection: ArenaConnection; settings: Settings; setSettings: (value: Settings) => void; player: PlayerSession; onLeave: () => void }) {
  const state = useSyncExternalStore(connection.subscribe, connection.getSnapshot);
  const container = useRef<HTMLDivElement>(null); const game = useRef<GameView | null>(null);
  const [input, setInput] = useState<InputController | null>(null);
  const [paused, setPaused] = useState(false); const [showSettings, setShowSettings] = useState(false);
  const [stats, setStats] = useState({ fps: 0, locked: false });
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [autoTarget, setAutoTarget] = useState(false);
  const [readiness, setReadiness] = useState<ReadinessState>({ ready: false, pending: false, error: '' });
  const [renderedPreparationId, setRenderedPreparationId] = useState('');
  const preparation = useRef<PreparationReadiness | null>(null);
  const availability = useRef({ assetsReady: false, renderedPreparationId: '', error: false, paused: false, settings: false });
  const syncControls = useRef<() => void>(() => {});
  const [touch] = useState(() => matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0);
  const [tabScore, setTabScore] = useState(false);
  const [localNow, setLocalNow] = useState(Date.now());
  const lastEvent = useRef<GameEvent | null>(null);
  const snapshot = state.snapshot;
  const me = snapshot?.players.find(p => p.id === state.playerId);
  const serverNow = snapshot?.serverTime || localNow;
  // Room transitions arrive before their world snapshot, particularly on rematch.
  const phase = state.room?.phase ?? snapshot?.phase;
  const finished = phase === 'finished';
  const preparing = phase === 'preparing';
  const preparationRendered = !!state.room?.preparation?.id && renderedPreparationId === state.room.preparation.id;
  const countdown = phase === 'countdown';
  const dead = !!me && me.health <= 0;

  useEffect(() => {
    if (!container.current) return;
    let view: GameView | null = null;
    let active = true;
    const controller = new InputController(undefined, settings);
    const gyroscope = new GyroscopeInput(controller);
    availability.current.assetsReady = false;
    availability.current.renderedPreparationId = '';
    availability.current.error = false;
    const ready = new PreparationReadiness(controller, () => {
      const current = connection.getSnapshot();
      return { roomId: current.room?.id ?? '', phase: current.room?.phase, preparationId: current.room?.preparation?.id,
        connected: current.status === 'connected', assetsReady: availability.current.assetsReady
          && !!current.room?.preparation?.id && availability.current.renderedPreparationId === current.room.preparation.id,
        blocked: availability.current.error || availability.current.paused || availability.current.settings };
    }, (preparationId, acknowledged) => connection.send({ type: 'ready', preparationId, ready: acknowledged }), setReadiness);
    preparation.current = ready;
    const synchronize = () => {
      if (!active) return;
      const current = connection.getSnapshot();
      controller.setGameplayBlocked(current.room?.phase !== 'playing' || !!current.snapshot?.players.some(p => p.id === current.playerId && p.health <= 0));
      controller.setPaused(!availability.current.assetsReady || availability.current.error || availability.current.paused
        || availability.current.settings || current.room?.phase === 'finished' || current.status !== 'connected');
      ready.sync();
    };
    syncControls.current = synchronize;
    const unsubscribe = connection.subscribe(synchronize);
    synchronize();
    controller.onLockChange = locked => { if (active) setStats(previous => ({ ...previous, locked })); };
    try {
      view = new GameView(container.current, { input: controller, getSnapshot: () => connection.getSnapshot().snapshot, getPlayerId: () => connection.getSnapshot().playerId, settings, onStats: setStats,
        getPreparationId: () => { const room = connection.getSnapshot().room; return room?.phase === 'preparing' ? room.preparation?.id : undefined; },
        onPreparationRendered: roundId => {
          const room = connection.getSnapshot().room;
          if (!active || room?.phase !== 'preparing' || room.preparation?.id !== roundId) return;
          availability.current.renderedPreparationId = roundId; synchronize(); setRenderedPreparationId(roundId);
        },
        onAssetsReady: () => { if (!active) return; availability.current.assetsReady = true; synchronize(); setLoading(false); },
        onError: message => { if (!active) return; availability.current.error = true; synchronize(); setLoadError(message); setLoading(false); } });
      game.current = view; setInput(controller);
    } catch { availability.current.error = true; synchronize(); setLoadError('This device could not start 3D graphics. Try an up-to-date browser with hardware acceleration enabled.'); controller.dispose(); setLoading(false); }
    const send = setInterval(() => {
      if (!view || connection.getSnapshot().status !== 'connected') return;
      setAutoTarget(view.prepareAutomaticFire());
      const frame = controller.current(); connection.send({ type: 'input', input: frame }); view.recordInput(frame);
    }, 1000 / 30);
    const time = setInterval(() => setLocalNow(Date.now()), 150);
    const down = (e: KeyboardEvent) => { if (e.code === 'Tab') { e.preventDefault(); setTabScore(true); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Tab') setTabScore(false); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { active = false; unsubscribe(); ready.dispose(); gyroscope.dispose(); preparation.current = null; syncControls.current = () => {}; clearInterval(send); clearInterval(time); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); view?.dispose(); controller.dispose(); game.current = null; };
  }, [connection]);
  useEffect(() => { game.current?.setSettings(settings); input?.setSettings(settings); }, [settings, input]);
  useEffect(() => {
    const index = lastEvent.current ? state.events.indexOf(lastEvent.current) : -1;
    for (const event of state.events.slice(index + 1)) {
      if (lastEvent.current || event.at >= (connection.getSnapshot().snapshot?.serverTime || Date.now()) - 500) game.current?.handleEvent(event);
    }
    lastEvent.current = state.events.at(-1) || null;
  }, [state.events]);
  const pause = () => { availability.current.paused = true; syncControls.current(); setPaused(true); };
  const settingsOpen = (open: boolean) => { availability.current.settings = open; syncControls.current(); setShowSettings(open); };
  const resume = () => {
    availability.current.paused = false; syncControls.current(); setPaused(false);
    // Preparing needs its own explicit acknowledgement; countdown/playing can recapture without changing the round.
    if (!touch && connection.getSnapshot().room?.phase !== 'preparing') void input?.requestPointerLock();
  };
  const events = state.events.filter(e => serverNow - e.at < 4500);
  const hit = events.some(e => e.type === 'shot' && e.playerId === state.playerId && e.hit && serverNow - e.at < 180);
  const damaged = events.some(e => e.type === 'damage' && e.playerId === state.playerId && serverNow - e.at < 250);
  const rows = [...(snapshot?.players || [])].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  const endEvent = [...state.events].reverse().find(e => e.type === 'match-end');
  const winner = snapshot?.winnerIds.length === 1 ? snapshot.players.find(p => p.id === snapshot.winnerIds[0]) : null;
  const healingSeconds = Math.max(0, ((me?.healingUntil || 0) - serverNow) / 1000);
  const reloadSeconds = Math.max(0, ((me?.reloadingUntil || 0) - serverNow) / 1000);

  return <main className={`game-screen ${touch ? 'touch-game' : ''} ${damaged ? 'taking-damage' : ''}`}>
    <div ref={container} className="game-canvas" aria-label="Kannon Town 3D arena"/>
    {(loading || loadError) && <div className="game-cover"><h2>{loadError ? 'Graphics unavailable' : 'Entering Kannon Town…'}</h2><p>{loadError || 'Preparing the arena and your loadout.'}</p><button className={`button ${loadError ? 'primary' : 'secondary'}`} onClick={onLeave}>Back to menu</button></div>}
    <div className="game-hud">
      <div className="arena-label"><span>Kannon Town</span><strong>{state.room?.practice ? `${practiceLevelName(state.room.practiceDifficulty)} practice` : state.room?.ranked ? 'Ranked crew match' : 'Private match'}</strong></div>
      <div className="score-clock"><div><strong>{me?.kills || 0}</strong><span>/ {RULES.scoreLimit}</span></div><time>{clock(preparing || countdown ? RULES.matchSeconds : snapshot?.timeRemaining ?? RULES.matchSeconds)}</time></div>
      <div className="game-top-actions"><span className={`connection-metric ${state.latency > 160 ? 'high-ping' : ''}`}>{state.status === 'connected' ? `${state.latency} ms` : 'Reconnecting…'}</span><button className="icon-button" aria-label="Pause menu" onClick={pause}><Icon name="pause"/></button></div>
      <div className="match-roster">{rows.slice(0, 8).map(p => <div key={p.id}><span className="player-dot" style={{ background: p.color }}/><span>{p.name}</span><strong>{p.kills}</strong></div>)}</div>
      <div className="kill-feed" aria-live="polite">{events.filter(e => e.type === 'elimination').slice(-3).map((event, index) => event.type === 'elimination' ? <div key={`${event.at}-${index}`}><strong>{snapshot?.players.find(p => p.id === event.attackerId)?.name || 'Player'}</strong><Icon name="ar" size={19}/><span>{snapshot?.players.find(p => p.id === event.playerId)?.name || 'Player'}</span></div> : null)}</div>
      {!dead && !finished && !preparing && !countdown && <div className={`crosshair ${hit ? 'hit' : ''} ${autoTarget ? 'auto-target' : ''} ${me?.slot === 2 ? 'shotgun-crosshair' : ''}`}><i/><i/><i/><i/>{hit && <span>×</span>}</div>}
      <div className="vitals"><div className="health-row"><Icon name="heal" size={19}/><strong>{Math.max(0, me?.health ?? 100)}</strong><div className="vital-track"><div style={{ width: `${me?.health ?? 100}%` }}/></div></div><div className="shield-row"><Icon name="shield" size={19}/><strong>{me?.shield ?? 50}</strong><div className="vital-track"><div style={{ width: `${(me?.shield ?? 50) * 2}%` }}/></div></div></div>
      <div className="weapon-hud"><div className="ammo">{me?.slot === 3 ? <><Icon name="heal" size={23}/><strong>{me?.heals ?? 2}</strong><span>charges</span></> : <><strong>{me?.slot === 2 ? me.ammoShotgun : me?.ammoAR ?? 30}</strong><span>/ ∞</span></>}</div><Loadout selected={me?.slot || 1} heals={me?.heals ?? 2} onSelect={slot => input?.setSlot(slot)}/></div>
      {(healingSeconds > 0 || reloadSeconds > 0) && <div className="action-progress"><span>{healingSeconds > 0 ? 'Healing' : 'Reloading'} · {(healingSeconds || reloadSeconds).toFixed(1)}s</span><progress max={healingSeconds > 0 ? 3 : me?.slot === 2 ? 2.4 : 1.8} value={(healingSeconds > 0 ? 3 : me?.slot === 2 ? 2.4 : 1.8) - (healingSeconds || reloadSeconds)}/></div>}
      {!dead && !preparing && !countdown && !finished && (me?.protectedUntil || 0) > serverNow && <div className="protection-label"><Icon name="shield" size={14}/> Spawn protection</div>}
      {!touch && !paused && !showSettings && !finished && !preparing && !stats.locked && !loading && !loadError && state.status === 'connected' && <button className="mouse-prompt" onClick={resume}><Icon name="play" size={18}/>{countdown ? 'Capture mouse' : 'Click to play'}<span>WASD move · Mouse aim · 1 / 2 / 3 loadout · Esc releases mouse</span></button>}
      {!touch && <span className="game-bottom-hint">Hold Tab for scores · R reload · Shift sprint · Space jump</span>}
    </div>
    {touch && input && !dead && !paused && !finished && !showSettings && !preparing && !countdown && !loading && !loadError && state.status === 'connected' && <TouchControls input={input} healingSlot={me?.slot === 3}/>}
    {touch && <div className="portrait-hint"><Icon name="phone" size={30}/><span>Turn your phone sideways for the best view.</span></div>}
    {preparing && !loading && !loadError && !paused && !showSettings && state.status === 'connected' && <section className="preparation-panel" aria-label="Match readiness">
      <h2>{!preparationRendered ? 'Preparing your next round…' : readiness.ready ? 'Waiting for your rivals…' : 'Your arena is ready.'}</h2>
      <p>{!preparationRendered ? 'Getting everyone into position.' : readiness.ready ? 'The countdown starts when everyone is ready.' : 'Everyone gets the full countdown before the match begins.'}</p>
      <ul>{state.room?.players.map(person => <li key={person.id}><span className="player-dot" style={{ background: person.color }}/><span>{person.name}{person.id === state.playerId ? ' (you)' : ''}</span><strong className={person.ready ? 'is-ready' : ''}>{!person.connected ? 'Reconnecting' : person.ready ? 'Ready' : 'Not ready'}</strong></li>)}</ul>
      {preparationRendered && !readiness.ready && <button className="button primary full-width" disabled={!input || readiness.pending} onClick={() => void preparation.current?.engage(touch)}><Icon name="play"/>{readiness.pending ? 'Capturing mouse…' : 'Ready to play'}</button>}
      {readiness.error && <p className="error-message" role="alert">{readiness.error}</p>}
      {!touch && <small>{readiness.ready ? 'Esc releases your mouse and marks you not ready.' : 'Click to capture your mouse. Esc releases it.'}</small>}
    </section>}
    {countdown && <div className="center-message"><span>Get ready</span><strong>{Math.max(1, Math.ceil(snapshot?.phase === 'countdown' ? snapshot.timeRemaining : 3))}</strong><p>{state.room?.practice ? 'Warm up. Find your rhythm.' : 'Same loadout. Let’s settle it.'}</p></div>}
    {dead && !finished && !preparing && <div className="respawn-message"><h2>Back in {Math.max(1, Math.ceil(((me?.respawnAt || serverNow) - serverNow) / 1000))}</h2><p>Fresh loadout. Next life.</p></div>}
    {state.status !== 'connected' && <div className="connection-cover"><Icon name="link" size={30}/><h2>{state.status === 'offline' ? 'Connection lost' : 'Getting you back in…'}</h2><p>Your spot is held briefly while we reconnect.</p><div className="button-row"><button className="button primary small" onClick={() => void connection.connect().catch(() => {})}>Try again</button><button className="button secondary small" onClick={onLeave}>Back to menu</button></div></div>}
    {state.error && <div className="game-error" role="alert">{state.error}<button className="icon-button" aria-label="Dismiss error" onClick={connection.clearError}><Icon name="close" size={16}/></button></div>}
    {(finished || tabScore) && <div className={`scoreboard-overlay ${finished ? 'results' : ''}`}><div className="scoreboard-panel">{finished ? <><Icon name="trophy" size={40}/><h1>{snapshot?.winnerIds.includes(state.playerId) && snapshot.winnerIds.length === 1 ? 'That round was yours.' : winner ? `${winner.name} takes the round.` : snapshot?.winnerIds.length ? 'Honors shared.' : 'Round ended.'}</h1><p>{endEvent?.type === 'match-end' ? endEvent.reason : 'Good game. Ready for another?'}</p></> : <h2>Match standings</h2>}<table><thead><tr><th>Player</th><th>Elims</th><th>Deaths</th></tr></thead><tbody>{rows.map(p => <tr key={p.id} className={p.id === state.playerId ? 'you-row' : ''}><td><span className="player-dot" style={{ background: p.color }}/>{p.name}{p.id === state.playerId && <span className="you-label">You</span>}</td><td>{p.kills}</td><td>{p.deaths}</td></tr>)}</tbody></table>{finished && <><p className="result-rating">{endEvent?.type === 'match-end' && endEvent.ranked ? 'This result was saved to your crew leaderboard.' : 'This round did not change your crew rating.'}</p><div className="button-row">{state.room?.hostId === state.playerId ? <button className="button primary" onClick={() => { availability.current.paused = false; setPaused(false); connection.clearError(); connection.send({ type: 'rematch' }); }}><Icon name="play" size={20}/> Play again</button> : <p className="muted">Waiting for the host to start a rematch.</p>}<button className="button secondary" onClick={onLeave}>Back to menu</button></div></>}</div></div>}
    {paused && !finished && !showSettings && <div className="pause-cover"><div className="pause-panel"><h2>Take a breath.</h2><p>{preparing ? 'The match waits until everyone is ready.' : 'The match keeps running while your menu is open.'}</p><button className="button primary full-width" onClick={resume}><Icon name="play"/> Resume game</button><button className="button secondary full-width" onClick={() => settingsOpen(true)}><Icon name="settings"/> Settings</button><button className="text-button" onClick={onLeave}>Leave match</button><span className="muted small-type">{stats.fps ? `${Math.round(stats.fps)} FPS · ` : ''}{state.latency} ms round trip</span></div></div>}
    {showSettings && <SettingsDialog settings={settings} onChange={setSettings} player={player} onPlayer={() => {}} onClose={() => settingsOpen(false)} inGame/>}
  </main>;
}
