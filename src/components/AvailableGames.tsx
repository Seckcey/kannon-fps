import { useEffect, useState } from 'react';
import type { AvailableGame } from '../../shared/protocol';
import { api } from '../lib/api';
import { practiceLevelName } from '../lib/practice';
import { Icon } from './Icon';

export function AvailableGames({ name, onName, onJoin, onCreate, onCancel, busy, preparingArt, error }: {
  name: string; onName: (name: string) => void; onJoin: (id: string) => void; onCreate: () => void;
  busy: boolean; preparingArt: boolean; error: string;
  onCancel: () => void;
}) {
  const [games, setGames] = useState<AvailableGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (busy) return;
    let active = true, pending = false;
    let timer: ReturnType<typeof setTimeout>;
    const update = async () => {
      if (!active || pending || document.hidden) return;
      pending = true; setLoading(true);
      try {
        const result = await api<{ games: AvailableGame[] }>('/games');
        if (active) { setGames(result.games); setLoadError(''); setLoaded(true); }
      } catch (error) { if (active) setLoadError((error as Error).message); }
      finally {
        pending = false;
        if (active) { setLoading(false); timer = setTimeout(() => void update(), 5000); }
      }
    };
    const resume = () => { if (!document.hidden) { clearTimeout(timer); void update(); } };
    void update(); document.addEventListener('visibilitychange', resume);
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', resume); };
  }, [busy, refresh]);

  return <section className="content-page games-page">
    <div className="page-title"><h1>Available Games</h1><p>Find a public lobby and join. No invitation needed.</p></div>
    <div className="games-toolbar">
      <label className="field-label">Player name<input value={name} onChange={event => onName(event.target.value)} disabled={busy} maxLength={20} autoComplete="nickname" placeholder="Player"/></label>
      <div className="button-row"><button className="button secondary small" disabled={busy || loading} onClick={() => setRefresh(value => value + 1)}>{loading ? 'Refreshing…' : 'Refresh'}</button><button className="button primary small" disabled={busy} onClick={onCreate}><Icon name="play" size={20}/>Create public game</button></div>
    </div>
    <p className="games-note">Kannon Town · Casual · Up to 8 people. Join before the host starts. The list refreshes automatically.</p>
    {error && <p className="error-message" role="alert">{error}</p>}
    {loadError && <p className="error-message" role="alert">{loadError} Use Refresh to try again.</p>}
    {busy && <div className="games-status"><p role="status">{preparingArt ? 'Preparing arena…' : 'Joining game…'}</p><button className="text-button" onClick={onCancel}>Cancel joining</button></div>}
    {!loadError && !games.length && <div className="games-empty" role="status"><Icon name="users" size={38}/><h2>{!loaded && loading ? 'Finding games…' : 'No public games waiting'}</h2><p>{!loaded && loading ? 'Checking the arena for open lobbies.' : 'Create a public game for others to join. Turn on bots and you can start playing on your own.'}</p></div>}
    {games.length > 0 && <ul className="available-games">{games.map(game => <li key={game.id}>
      <div className="game-list-copy"><span className="public-badge">Public · Waiting for players</span><h2>{game.hostName}’s game</h2><p>{game.humanCount} / {game.maxPlayers} people{game.botCount > 0 ? ` · ${game.botCount} AI rivals` : ''}</p><small>{game.fillBots ? `${practiceLevelName(game.botDifficulty)} bots fill to 4 players. People replace bots in the lobby.` : 'Human players only.'}</small></div>
      <button className="button primary" disabled={busy || !!loadError} aria-label={`Join ${game.hostName}’s game`} onClick={() => onJoin(game.id)}>Join<Icon name="arrow" size={22}/></button>
    </li>)}</ul>}
  </section>;
}
