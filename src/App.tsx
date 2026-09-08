import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Crew } from '../shared/protocol';
import { Icon } from './components/Icon';
import { Modal } from './components/Modal';
import { Loadout } from './components/Loadout';
import { SettingsDialog } from './components/SettingsDialog';
import { Leaderboard } from './components/Leaderboard';
import { Lobby } from './components/Lobby';
import { Help } from './components/Help';
import { api } from './lib/api';
import { ArenaConnection, type ConnectionState } from './lib/connection';
import { extractInvite, readPlayer, readSettings, savePlayer, saveSettings, type PlayerSession, type Settings } from './lib/storage';

const GameScreen = lazy(() => import('./components/GameScreen'));
const noConnection: ConnectionState = { status: 'idle', playerId: '', room: null, snapshot: null, events: [], error: '', latency: 0 };
const emptySubscribe = () => () => {};
const emptySnapshot = () => noConnection;
type Tab = 'play' | 'leaderboard' | 'help';

export function App() {
  const [player, setPlayer] = useState<PlayerSession | null>(readPlayer);
  const playerRef = useRef(player);
  const [name, setName] = useState(player?.profile.name || '');
  const [settings, setSettingsState] = useState<Settings>(readSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [initialInvite] = useState(() => new URLSearchParams(location.hash.slice(1)));
  const [tab, setTab] = useState<Tab>(initialInvite.has('crew') ? 'leaderboard' : 'play');
  const [dialog, setDialog] = useState<'create' | 'join' | null>(initialInvite.has('room') ? 'join' : null);
  const [invite, setInvite] = useState(initialInvite.get('room') || '');
  const [crews, setCrews] = useState<Crew[]>([]);
  const [selectedCrew, setSelectedCrew] = useState('');
  const [ranked, setRanked] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<ArenaConnection | null>(null);
  const connectionRef = useRef<ArenaConnection | null>(null);
  const ensurePromise = useRef<Promise<PlayerSession> | null>(null);
  const state = useSyncExternalStore(connection?.subscribe || emptySubscribe, connection?.getSnapshot || emptySnapshot);
  const setSettings = (value: Settings) => { setSettingsState(value); try { saveSettings(value); } catch { /* game still works in private browsing */ } };
  const acceptPlayer = useCallback((value: PlayerSession) => {
    if (playerRef.current?.token !== value.token) { connectionRef.current?.dispose(); connectionRef.current = null; setConnection(null); }
    playerRef.current = value; setPlayer(value); setName(value.profile.name);
    try { savePlayer(value); } catch { setError('This browser cannot save your player. Copy your player key in Settings before leaving.'); }
  }, []);
  const ensurePlayer = useCallback(async (): Promise<PlayerSession> => {
    if (ensurePromise.current) return ensurePromise.current;
    const current = playerRef.current;
    const nextName = name.trim() || current?.profile.name || 'Player';
    if (current && current.profile.name === nextName) return current;
    ensurePromise.current = api<PlayerSession>('/profile', undefined, { name: nextName, ...(current ? { token: current.token } : {}) }).then(value => { acceptPlayer(value); return value; }).finally(() => { ensurePromise.current = null; });
    return ensurePromise.current;
  }, [name, acceptPlayer]);
  const refreshCrews = useCallback(async () => {
    const session = playerRef.current;
    if (!session) return;
    const result = await api<{ crews: Crew[] }>('/crews', session.token); setCrews(result.crews);
    setSelectedCrew(current => result.crews.some(c => c.id === current) ? current : result.crews[0]?.id || '');
  }, []);
  useEffect(() => { if (player) void refreshCrews().catch(() => {}); else setCrews([]); }, [player, refreshCrews]);
  useEffect(() => () => connectionRef.current?.dispose(), []);
  useEffect(() => { if (state.room) { setDialog(null); setBusy(false); setError(''); if (initialInvite.has('room')) history.replaceState(null, '', location.pathname); } }, [state.room, initialInvite]);
  useEffect(() => { if (state.error) { setError(state.error); setBusy(false); } }, [state.error]);

  const getConnection = async () => {
    const session = await ensurePlayer();
    let current = connectionRef.current;
    if (!current) { current = new ArenaConnection(session.token); connectionRef.current = current; setConnection(current); }
    await current.connect(); return current;
  };
  const createMatch = async (practice = false) => {
    setBusy(true); setError('');
    try {
      const current = await getConnection();
      current.clearError(); current.send({ type: 'create', ranked: !practice && ranked, ...(selectedCrew && ranked && !practice ? { crewId: selectedCrew } : {}), practice });
      // Rendering begins after the server accepts and broadcasts the room.
      setTimeout(() => { if (!current.getSnapshot().room) { setBusy(false); setError(current.getSnapshot().error || 'The room could not be created. Try again.'); } }, 6000);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const joinMatch = async () => {
    setBusy(true); setError('');
    try { const current = await getConnection(); current.clearError(); current.send({ type: 'join', code: extractInvite(invite) }); setTimeout(() => { if (!current.getSnapshot().room) setBusy(false); }, 6000); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const leaveMatch = () => { connection?.leave(); setTab('play'); setBusy(false); setError(''); };
  const startMatch = () => { setBusy(true); setError(''); connection?.clearError(); connection?.send({ type: 'start' }); setTimeout(() => setBusy(false), 1500); };
  const active = state.room && state.room.phase !== 'waiting';
  if (active && state.room && connection && player) return <Suspense fallback={<main className="fatal-screen"><h1>Entering Sunbreak…</h1><p>Loading your arena.</p></main>}><GameScreen key={state.room.id} connection={connection} settings={settings} setSettings={setSettings} player={player} onLeave={leaveMatch}/></Suspense>;

  return <div className={`app-shell ${tab === 'play' ? 'play-page' : 'inner-page'} ${state.room ? 'has-room' : ''}`}>
    {tab === 'play' && <div className="lobby-art" aria-hidden="true"/>}
    <header className="app-header"><button className="wordmark" aria-label="Kannon Arena home" onClick={() => setTab('play')}><span>Kannon</span><small><i/>Arena<i/></small></button><nav aria-label="Main navigation">{([['play', 'Play'], ['leaderboard', 'Leaderboard'], ['help', 'How to play']] as const).map(([id, label]) => <button key={id} onClick={() => setTab(id)} className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined}>{label}</button>)}</nav><button className="icon-button header-settings" aria-label="Settings" onClick={() => setShowSettings(true)}><Icon name="settings" size={30}/></button></header>
    <main className="menu-main">
      {tab === 'play' && !state.room && <section className="play-home"><div className="play-main"><h1><span>Your crew.</span><span>Your arena.</span></h1><p className="tagline">Good rivals. Great games.</p><form className="player-panel" onSubmit={e => { e.preventDefault(); setDialog('create'); setError(''); }}><label className="field-label" htmlFor="player-name">Player name</label><div className="name-input"><input id="player-name" autoComplete="nickname" maxLength={20} value={name} onChange={e => setName(e.target.value)} placeholder="Player" aria-describedby="name-help"/><Icon name="shield" size={20}/></div><span id="name-help" className="sr-only">Choose a nickname. No real name needed.</span><button className="button primary full-width" type="submit" disabled={busy}><Icon name="play" size={25}/> Create private match</button><button className="button secondary full-width" type="button" onClick={() => { setDialog('join'); setError(''); }} disabled={busy}><Icon name="users" size={26}/> Join with invite</button><button className="practice-button" type="button" disabled={busy} onClick={() => void createMatch(true)}>{busy ? 'Connecting…' : 'Practice first'}<Icon name="arrow" size={21}/></button></form>{error && <p className="error-message" role="alert">{error}</p>}</div><footer className="play-footer"><div className="rule-strip"><span><Icon name="users" size={23}/>2–8 players</span><i/><span><Icon name="clock" size={22}/>5 minutes</span><i/><span><Icon name="target" size={22}/>First to 15</span></div><Loadout compact/></footer></section>}
      {tab === 'play' && state.room && <><Lobby room={state.room} playerId={state.playerId} onStart={startMatch} onLeave={leaveMatch} busy={busy}/>{error && <p className="error-message lobby-error" role="alert">{error}</p>}{state.status !== 'connected' && <div className="connection-banner" role="status">Reconnecting to your room… <button className="text-button" onClick={() => void connection?.connect().catch(() => {})}>Retry</button></div>}</>}
      {tab === 'leaderboard' && <Leaderboard player={player} ensurePlayer={ensurePlayer} crews={crews} onCrews={refreshCrews} initialInvite={initialInvite.get('crew') || ''}/>}
      {tab === 'help' && <Help/>}
    </main>
    {showSettings && <SettingsDialog settings={settings} onChange={setSettings} player={player} onPlayer={acceptPlayer} onClose={() => setShowSettings(false)}/>}
    {dialog === 'create' && <Modal title="Make it your match." onClose={() => { if (!busy) setDialog(null); }}><p className="modal-intro">A private Sunbreak free-for-all. Invite your friends, then start when everyone is ready.</p><div className="match-choice"><button className={!ranked ? 'selected' : ''} onClick={() => setRanked(false)}><Icon name="users"/><strong>Casual</strong><span>Just play. No ratings.</span></button><button className={ranked ? 'selected' : ''} onClick={() => setRanked(true)}><Icon name="trophy"/><strong>Ranked</strong><span>Put it on the board.</span></button></div>{ranked && <div className="ranked-setup">{crews.length ? <label className="field-label">Choose your crew<select value={selectedCrew} onChange={e => setSelectedCrew(e.target.value)}>{crews.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><small>Everyone joining must belong to this crew.</small></label> : <p>Create a friend crew on the Leaderboard first. <button className="text-button" onClick={() => { setDialog(null); setTab('leaderboard'); }}>Set up your crew <Icon name="arrow" size={15}/></button></p>}</div>}<div className="modal-rule-line">2–8 players · 5 minutes · First to 15</div>{error && <p className="error-message" role="alert">{error}</p>}<button className="button primary full-width" disabled={busy || (ranked && !selectedCrew)} onClick={() => void createMatch()}><Icon name="play"/>{busy ? 'Creating room…' : 'Create room'}</button></Modal>}
    {dialog === 'join' && <Modal title="Your rival is waiting." onClose={() => { if (!busy) setDialog(null); }}><form onSubmit={e => { e.preventDefault(); void joinMatch(); }}><p className="modal-intro">Paste the match invitation or enter the room code your friend shared.</p><label className="field-label">Match invitation<input autoFocus required maxLength={500} value={invite} onChange={e => setInvite(e.target.value)} placeholder="Room code or invitation link" autoComplete="off" spellCheck={false}/></label>{!player && <p className="muted small-type">You’ll join as {name.trim() || 'Player'}. Set your nickname on the Play screen.</p>}{error && <p className="error-message" role="alert">{error}</p>}<button className="button primary full-width" disabled={busy || !invite.trim()}><Icon name="users"/>{busy ? 'Joining…' : 'Join match'}</button></form></Modal>}
  </div>;
}
