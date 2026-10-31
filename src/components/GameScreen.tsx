import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RULES, type GameEvent, type GameMode, type StreakId } from '../../shared/protocol';
import type { ArenaConnection } from '../lib/connection';
import { isTouchDevice, type PlayerSession, type Settings } from '../lib/storage';
import { GameView } from '../game/GameView';
import { HudStore } from '../game/hud';
import { InputController } from '../game/InputController';
import { GyroscopeInput } from '../game/Gyroscope';
import { PreparationReadiness, type ReadinessState } from '../game/PreparationReadiness';
import { practiceLevelName } from '../lib/practice';
import { Icon } from './Icon';
import { TouchControls } from './TouchControls';
import { SettingsDialog } from './SettingsDialog';
import { LoadoutDialog, LoadoutSummary } from './Loadout';
import { MODE_INFO, TEAM_NAMES } from './labels';
import { PRESET_INFO } from './loadoutInfo';
import { CombatHud } from './hud/CombatHud';
import { CombatCallouts, KillFeed, ScoreBar } from './hud/MatchHud';
import { Scoreboard } from './hud/Scoreboard';
import { useHudValue, useSafeArea, useViewport } from './hud/hooks';
import { clock, eliminatedBy, killFeed, matchResult, nameLookup, recentMedals, rewardReady, scoreboard, scorePopups, scoreSummary, threatNotices, topScorer, type Viewer } from './hud/match';
import { touchLayout } from './hud/touchLayout';

export default function GameScreen({ connection, settings, setSettings, player, onLeave }: { connection: ArenaConnection; settings: Settings; setSettings: (value: Settings) => void; player: PlayerSession; onLeave: () => void }) {
  const state = useSyncExternalStore(connection.subscribe, connection.getSnapshot);
  const container = useRef<HTMLDivElement>(null); const game = useRef<GameView | null>(null);
  const [hud] = useState(() => new HudStore());
  const [input, setInput] = useState<InputController | null>(null);
  const [paused, setPaused] = useState(false); const [showSettings, setShowSettings] = useState(false);
  const [showLoadout, setShowLoadout] = useState(false);
  const [stats, setStats] = useState({ fps: 0, locked: false });
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [autoTarget, setAutoTarget] = useState(false);
  const [readiness, setReadiness] = useState<ReadinessState>({ ready: false, pending: false, error: '' });
  const [renderedPreparationId, setRenderedPreparationId] = useState('');
  const preparation = useRef<PreparationReadiness | null>(null);
  const availability = useRef({ assetsReady: false, renderedPreparationId: '', error: false, paused: false, settings: false, loadout: false });
  const syncControls = useRef<() => void>(() => {});
  const [touch] = useState(isTouchDevice);
  const [tabScore, setTabScore] = useState(false);
  const [touchScores, setTouchScores] = useState(false);
  const [localNow, setLocalNow] = useState(Date.now());
  const lastEvent = useRef<GameEvent | null>(null);
  const viewport = useViewport(), safe = useSafeArea();
  const rewardKey = useHudValue(hud, frame => frame?.rewards.join(',') ?? '');
  const targeting = useHudValue(hud, frame => !!frame?.mortarTargeting);
  const rewards = (rewardKey ? rewardKey.split(',') : []) as StreakId[];
  const snapshot = state.snapshot;
  const self = snapshot?.self;
  const me = self ?? snapshot?.players.find(p => p.id === state.playerId);
  const serverNow = snapshot?.serverTime || localNow;
  // Room transitions arrive before their world snapshot, particularly on rematch.
  const phase = state.room?.phase ?? snapshot?.phase;
  const finished = phase === 'finished';
  const preparing = phase === 'preparing';
  const preparationRendered = !!state.room?.preparation?.id && renderedPreparationId === state.room.preparation.id;
  const countdown = phase === 'countdown';
  const playing = phase === 'playing';
  const dead = !!me && me.health <= 0;
  const mode: GameMode = snapshot?.mode ?? state.room?.mode ?? 'ffa';
  const viewer: Viewer = { id: state.playerId, team: me?.team ?? state.room?.players.find(p => p.id === state.playerId)?.team };

  useEffect(() => {
    if (!container.current) return;
    let view: GameView | null = null;
    let active = true;
    const controller = new InputController(undefined, settings);
    const gyroscope = new GyroscopeInput(controller);
    availability.current.assetsReady = false;
    availability.current.renderedPreparationId = '';
    availability.current.error = false;
    const menuOpen = () => availability.current.paused || availability.current.settings || availability.current.loadout;
    const ready = new PreparationReadiness(controller, () => {
      const current = connection.getSnapshot();
      return { roomId: current.room?.id ?? '', phase: current.room?.phase, preparationId: current.room?.preparation?.id,
        connected: current.status === 'connected', assetsReady: availability.current.assetsReady
          && !!current.room?.preparation?.id && availability.current.renderedPreparationId === current.room.preparation.id,
        blocked: availability.current.error || menuOpen() };
    }, (preparationId, acknowledged) => connection.send({ type: 'ready', preparationId, ready: acknowledged }), setReadiness);
    preparation.current = ready;
    const synchronize = () => {
      if (!active) return;
      const current = connection.getSnapshot();
      controller.setGameplayBlocked(current.room?.phase !== 'playing' || !!current.snapshot?.players.some(p => p.id === current.playerId && p.health <= 0));
      controller.setPaused(!availability.current.assetsReady || availability.current.error || menuOpen()
        || current.room?.phase === 'finished' || current.status !== 'connected');
      ready.sync();
    };
    syncControls.current = synchronize;
    const unsubscribe = connection.subscribe(synchronize);
    synchronize();
    controller.onLockChange = locked => { if (active) setStats(previous => ({ ...previous, locked })); };
    try {
      view = new GameView(container.current, { input: controller, hud, getSnapshot: () => connection.getSnapshot().snapshot, getPlayerId: () => connection.getSnapshot().playerId, settings, onStats: setStats,
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
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Tab') { e.preventDefault(); setTabScore(true); }
      // While waiting to respawn, L opens the loadout picker (gameplay keys are inactive then).
      if (e.code === 'KeyL' && !e.repeat && !menuOpen()) {
        const current = connection.getSnapshot();
        if (current.snapshot?.players.some(p => p.id === current.playerId && p.health <= 0) && current.room?.phase === 'playing') { availability.current.loadout = true; synchronize(); setShowLoadout(true); }
      }
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Tab') setTabScore(false); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { active = false; unsubscribe(); ready.dispose(); gyroscope.dispose(); preparation.current = null; syncControls.current = () => {}; clearInterval(send); clearInterval(time); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); view?.dispose(); controller.dispose(); hud.clear(); game.current = null; };
  }, [connection, hud]);
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
  const loadoutOpen = (open: boolean) => { availability.current.loadout = open; syncControls.current(); setShowLoadout(open); };
  const resume = () => {
    availability.current.paused = false; syncControls.current(); setPaused(false);
    // Preparing needs its own explicit acknowledgement; countdown/playing can recapture without changing the round.
    if (!touch && connection.getSnapshot().room?.phase !== 'preparing') void input?.requestPointerLock();
  };

  const feed = state.feed;
  const lookup = nameLookup(snapshot?.players, state.room?.players);
  const loaded = !loading && !loadError;
  const live = playing && !dead && loaded;
  const mapVisible = (playing || countdown) && loaded;
  const menu = paused || showSettings || showLoadout;
  const entries = killFeed(feed, lookup, viewer, mode, serverNow, 6000, touch ? 3 : 5);
  const killer = dead ? eliminatedBy(feed, lookup, viewer, mode) : null;
  const groups = scoreboard(snapshot?.players ?? [], mode, viewer, snapshot?.teamScores);
  const summary = scoreSummary(snapshot, viewer, mode);
  const limit = summary.limit;
  const endEvent = [...feed].reverse().find((event): event is Extract<GameEvent, { type: 'match-end' }> => event.type === 'match-end');
  const top = topScorer(snapshot?.players ?? []);
  const damaged = state.events.some(e => e.type === 'damage' && e.playerId === state.playerId && serverNow - e.at < 250);
  const protectedNow = live && (me?.protectedUntil || 0) > serverNow;
  const roomLabel = state.room?.practice ? `${practiceLevelName(state.room.practiceDifficulty)} bot match` : state.room?.ranked ? 'Ranked crew match' : state.room?.visibility === 'public' ? 'Public match' : 'Private match';
  const layout = touch ? touchLayout({ ...viewport, safe, sprintButton: settings.sprintMode !== 'auto', rewards: rewards.length }) : null;
  const minimap = touch ? { size: Math.min(viewport.width, viewport.height) < 500 ? 96 : 128, range: 20 } : { size: Math.round(Math.max(150, Math.min(240, viewport.height * 0.2))), range: 30 };
  const respawnIn = Math.max(1, Math.ceil(((me?.respawnAt || serverNow) - serverNow) / 1000));

  return <main className={`game-screen ${touch ? 'touch-game' : 'desktop-game'} ${damaged ? 'taking-damage' : ''}`}>
    <div ref={container} className="game-canvas" aria-label="Kannon Town 3D arena"/>
    {(loading || loadError) && <div className="game-cover"><h2>{loadError ? 'Graphics unavailable' : 'Entering Kannon Town…'}</h2><p>{loadError || 'Preparing the arena and your loadout.'}</p><button className={`button ${loadError ? 'primary' : 'secondary'}`} onClick={onLeave}>Back to menu</button></div>}
    <div className="game-hud tactical-hud" style={{ ['--minimap-size' as string]: `${minimap.size}px` }}>
      <CombatHud hud={hud} input={input} touch={touch} live={live && !menu} status={mapVisible && !dead} autoTarget={autoTarget}
        streak={me?.streak ?? 0} loadout={me?.loadout} minimap={minimap} statusRect={layout?.status}/>
      {mapVisible && <span className="match-tag">{MODE_INFO[mode].name} · {roomLabel}</span>}
      <ScoreBar summary={summary} time={clock(preparing || countdown ? RULES.matchSeconds : snapshot?.timeRemaining ?? RULES.matchSeconds)}/>
      <div className="game-top-actions">
        <span className={`connection-metric ${state.latency > 160 ? 'high-ping' : ''}`}>{state.status === 'connected' ? `${state.latency} ms` : 'Reconnecting…'}</span>
        {touch && <button className="icon-button" aria-label="Match standings" aria-pressed={touchScores} onClick={() => setTouchScores(open => !open)}><Icon name="list"/></button>}
        <button className="icon-button" aria-label="Pause menu" onClick={pause}><Icon name="pause"/></button>
      </div>
      <KillFeed entries={entries}/>
      {live && <CombatCallouts popups={scorePopups(feed, state.playerId, serverNow, 2400, touch ? 2 : 4)} medals={recentMedals(feed, state.playerId, serverNow, 3200, touch ? 1 : 2)} reward={rewardReady(feed, state.playerId, serverNow)} notices={threatNotices(snapshot, self, mode)} touch={touch}/>}
      {protectedNow && <div className="protection-label"><Icon name="shield" size={14}/> Spawn protection · ends when you fire</div>}
      {!touch && !menu && !finished && !preparing && !stats.locked && !targeting && loaded && state.status === 'connected' && <button className="mouse-prompt" onClick={resume}><Icon name="play" size={18}/>{countdown ? 'Capture mouse' : 'Click to play'}<span>WASD move · Mouse look · Right click aim · Esc releases the mouse</span></button>}
      {!touch && (countdown || dead) && <span className="game-bottom-hint">Shift sprint, tap twice to dash · C crouch or slide · Space jump or vault · R reload · Q swap · G grenade · V knife · 4 reward · Tab scores</span>}
    </div>
    {touch && input && layout && !dead && !menu && !finished && !preparing && !countdown && loaded && state.status === 'connected' && <TouchControls input={input} hud={hud} settings={settings} layout={layout} rewards={rewards}/>}
    {touch && <div className="portrait-hint"><Icon name="phone" size={30}/><span>Turn your phone sideways for the best view.</span></div>}
    {preparing && loaded && !menu && state.status === 'connected' && <section className="preparation-panel" aria-label="Match readiness">
      <h2>{!preparationRendered ? 'Preparing your next round…' : readiness.ready ? 'Waiting for your rivals…' : 'Your arena is ready.'}</h2>
      <p>{!preparationRendered ? 'Getting everyone into position.' : readiness.ready ? 'The countdown starts when everyone is ready.' : 'Everyone gets the full countdown before the match begins.'}</p>
      <ul>{state.room?.players.map(person => <li key={person.id}><span className="player-dot" style={{ background: person.color }}/><span>{person.name}{person.id === state.playerId ? ' (you)' : ''}</span>{mode === 'tdm' && person.team && <em className={`team-chip ${person.team === viewer.team ? 'rel-friend' : 'rel-enemy'}`}>{TEAM_NAMES[person.team]}</em>}<strong className={person.ready ? 'is-ready' : ''}>{!person.connected ? 'Reconnecting' : person.ready ? 'Ready' : 'Not ready'}</strong></li>)}</ul>
      <LoadoutSummary value={settings} compact onEdit={readiness.ready ? undefined : () => loadoutOpen(true)}/>
      {preparationRendered && !readiness.ready && <button className="button primary full-width" disabled={!input || readiness.pending} onClick={() => void preparation.current?.engage(touch)}><Icon name="play"/>{readiness.pending ? 'Capturing mouse…' : 'Ready to play'}</button>}
      {readiness.error && <p className="error-message" role="alert">{readiness.error}</p>}
      {!touch && <small>{readiness.ready ? 'Esc releases your mouse and marks you not ready.' : 'Click to capture your mouse. Esc releases it.'}</small>}
    </section>}
    {countdown && <div className="center-message"><span>Get ready</span><strong>{Math.max(1, Math.ceil(snapshot?.phase === 'countdown' ? snapshot.timeRemaining : 3))}</strong><p>{mode === 'tdm' ? `You are on ${viewer.team ? `the ${TEAM_NAMES[viewer.team]} team` : 'a team'}. Stick together.` : state.room?.practice ? 'Warm up. Find your rhythm.' : 'Every elimination counts.'}</p></div>}
    {dead && !finished && !preparing && !menu && <div className="respawn-card" role="status">
      <span className="respawn-kicker">Eliminated</span>
      {killer ? <>
        <h2>{killer.attacker ? <>By <strong className={`rel-${killer.attacker.relation}`}>{killer.attacker.name}</strong></> : 'Caught in your own blast'}</h2>
        <p className="respawn-weapon"><Icon name={killer.icon} size={24}/>{killer.weapon}{killer.attacker ? ` · ${killer.distance} m` : ''}{killer.headshot ? ' · Headshot' : ''}</p>
      </> : <h2>You were eliminated</h2>}
      <p className="respawn-timer">Back in <strong>{respawnIn}</strong></p>
      <button className="button secondary small" onClick={() => loadoutOpen(true)}><Icon name="class" size={18}/>Change loadout</button>
      <small>{PRESET_INFO[settings.loadoutPreset].name} · {touch ? 'changes apply when you spawn' : 'press L to change, it applies when you spawn'}</small>
    </div>}
    {state.status !== 'connected' && <div className="connection-cover"><Icon name="link" size={30}/><h2>{state.status === 'offline' ? 'Connection lost' : 'Getting you back in…'}</h2><p>Your spot is held briefly while we reconnect.</p><div className="button-row"><button className="button primary small" onClick={() => void connection.connect().catch(() => {})}>Try again</button><button className="button secondary small" onClick={onLeave}>Back to menu</button></div></div>}
    {state.error && <div className="game-error" role="alert">{state.error}<button className="icon-button" aria-label="Dismiss error" onClick={connection.clearError}><Icon name="close" size={16}/></button></div>}
    {(finished || ((tabScore || touchScores) && !menu)) && <Scoreboard groups={groups} mode={mode} limit={limit} onClose={touchScores && !finished ? () => setTouchScores(false) : undefined}
      result={finished ? { result: matchResult(mode, viewer, snapshot?.winnerIds ?? endEvent?.winnerIds ?? [], snapshot?.winningTeam ?? endEvent?.winningTeam, [...(snapshot?.players ?? []), ...(state.room?.players ?? [])]),
        detail: endEvent?.reason || 'Good game. Ready for another?', topScorer: top ? { name: top.name, score: top.score } : null } : undefined}>
      {finished && <><p className="result-rating">{endEvent?.ranked ? 'This result was saved to your crew leaderboard.' : 'This round did not change your crew rating.'}</p><div className="button-row">{state.room?.hostId === state.playerId ? <button className="button primary" onClick={() => { availability.current.paused = false; setPaused(false); connection.clearError(); connection.send({ type: 'rematch' }); }}><Icon name="play" size={20}/> Play again</button> : <p className="muted">Waiting for the host to start a rematch.</p>}<button className="button secondary" onClick={onLeave}>Back to menu</button></div></>}
    </Scoreboard>}
    {paused && !finished && !showSettings && !showLoadout && <div className="pause-cover"><div className="pause-panel"><h2>Take a breath.</h2><p>{preparing ? 'The match waits until everyone is ready.' : 'The match keeps running while your menu is open.'}</p><button className="button primary full-width" onClick={resume}><Icon name="play"/> Resume game</button><button className="button secondary full-width" onClick={() => loadoutOpen(true)}><Icon name="class"/> Loadout</button><button className="button secondary full-width" onClick={() => settingsOpen(true)}><Icon name="settings"/> Settings</button><button className="text-button" onClick={onLeave}>Leave match</button><span className="muted small-type">{stats.fps ? `${Math.round(stats.fps)} FPS · ` : ''}{state.latency} ms round trip</span></div></div>}
    {showSettings && <SettingsDialog settings={settings} onChange={setSettings} player={player} onPlayer={() => {}} onClose={() => settingsOpen(false)} onTestSound={() => { void game.current?.testSound(); }} inGame touch={touch}/>}
    {showLoadout && <LoadoutDialog value={settings} onChange={choice => setSettings({ ...settings, ...choice })} onClose={() => loadoutOpen(false)} inGame/>}
  </main>;
}
