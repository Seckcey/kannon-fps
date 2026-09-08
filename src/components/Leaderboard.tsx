import { useEffect, useState } from 'react';
import type { Crew, LeaderboardEntry, MatchHistory } from '../../shared/protocol';
import { api } from '../lib/api';
import { copyText, extractInvite, invitation, type PlayerSession } from '../lib/storage';
import { Icon } from './Icon';

export function Leaderboard({ player, ensurePlayer, crews, onCrews, initialInvite }: {
  player: PlayerSession | null; ensurePlayer: () => Promise<PlayerSession>; crews: Crew[];
  onCrews: () => Promise<void>; initialInvite: string;
}) {
  const [selected, setSelected] = useState(crews[0]?.id || '');
  const [period, setPeriod] = useState<'all' | 'month'>('all');
  const [data, setData] = useState<{ entries: LeaderboardEntry[]; history: MatchHistory[] } | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<'create' | 'join' | null>(initialInvite ? 'join' : null);
  const [name, setName] = useState(''); const [invite, setInvite] = useState(initialInvite);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { if (!selected && crews[0]) setSelected(crews[0].id); }, [crews, selected]);
  useEffect(() => {
    if (!selected || !player) { setData(null); return; }
    let active = true; setLoading(true); setError(''); setData(null);
    api<{ entries: LeaderboardEntry[]; history: MatchHistory[] }>(`/leaderboard?crewId=${encodeURIComponent(selected)}&period=${period}`, player.token)
      .then(value => { if (active) setData(value); }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [selected, period, player, refresh]);
  const crew = crews.find(c => c.id === selected);
  return <section className="content-page leaderboard-page"><div className="page-title"><h1>Settle it in the arena.</h1><p>Your friends. Your standings. Every eligible match counts.</p></div>
    <div className="leaderboard-toolbar"><div className="crew-selector"><label htmlFor="crew-select">Your crew</label><select id="crew-select" value={selected} onChange={e => setSelected(e.target.value)} disabled={!crews.length}><option value="" disabled>Choose a crew</option>{crews.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div><div className="button-row"><button className="button secondary small" onClick={() => setForm(form === 'create' ? null : 'create')}><Icon name="users" size={18}/> Create crew</button><button className="text-button" onClick={() => setForm(form === 'join' ? null : 'join')}>Join a crew</button></div></div>
    {form && <form className="crew-form" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError(''); setNotice('');
      try {
        const session = await ensurePlayer();
        const { crew: added } = await api<{ crew: Crew }>(form === 'create' ? '/crews' : '/crews/join', session.token, form === 'create' ? { name: name.trim() } : { invite: extractInvite(invite, 'crew') });
        await onCrews(); setSelected(added.id); setForm(null); setName(''); setInvite(''); setNotice(`You’re in ${added.name}.`);
        if (initialInvite) history.replaceState(null, '', location.pathname);
      } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}><label className="field-label">{form === 'create' ? 'Crew name' : 'Crew invitation'}<input required maxLength={form === 'create' ? 32 : 500} value={form === 'create' ? name : invite} onChange={e => form === 'create' ? setName(e.target.value) : setInvite(e.target.value)} placeholder={form === 'create' ? 'The family rivalry' : 'Paste a crew invite link or code'}/></label><button className="button primary small" disabled={busy}>{busy ? 'One moment…' : form === 'create' ? 'Create crew' : 'Join crew'}</button></form>}
    {error && <p className="error-message" role="alert">{error}</p>}{notice && <p className="inline-message" role="status">{notice}</p>}
    {!crews.length && !loading ? <div className="empty-state"><Icon name="trophy" size={54}/><h2>Every rivalry starts somewhere.</h2><p>Create your crew and share its invitation with your friends. Play ranked matches together to put your names on the board.</p><button className="button primary" onClick={() => setForm('create')}>Start your crew</button></div> : <>
      <div className="standings-heading"><div><h2>{crew?.name || 'Your standings'}</h2><p className="muted">{crew?.memberCount || 0} members · Five eligible matches to place</p></div><div className="period-tabs" aria-label="Leaderboard period"><button className={period === 'all' ? 'active' : ''} onClick={() => setPeriod('all')}>All time</button><button className={period === 'month' ? 'active' : ''} onClick={() => setPeriod('month')}>This month</button></div></div>
      <div className="table-scroll"><table className="standings"><thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Rating</th><th scope="col">Wins</th><th scope="col">Matches</th><th scope="col">Elims</th><th scope="col">Win rate</th></tr></thead><tbody>{loading ? <tr><td colSpan={7} className="table-empty">Loading standings…</td></tr> : !data?.entries.length ? <tr><td colSpan={7} className="table-empty">No ranked results yet. Start a crew match from Play.</td></tr> : data.entries.map(entry => <tr key={entry.id} className={entry.id === player?.profile.id ? 'you-row' : ''}><td className="rank-cell">{entry.rank || '—'}</td><td><span className="player-dot" style={{ background: entry.color }}/><strong>{entry.name}</strong>{entry.id === player?.profile.id && <span className="you-label">You</span>}{!entry.placed && <small className="placement">Placing · {entry.matches}/5</small>}</td><td className="rating-cell">{entry.placed ? Math.round(entry.rating).toLocaleString() : '—'}</td><td>{entry.wins}</td><td>{entry.matches}</td><td>{entry.kills}</td><td>{Math.round(entry.winRate)}%</td></tr>)}</tbody></table></div>
      <div className="leaderboard-footer"><p>Ratings reflect results and opponent strength. Practice and casual games stay off this board.</p><div className="button-row"><button className="text-button" onClick={() => setRefresh(v => v + 1)}>Refresh</button>{crew && <button className="button secondary small" onClick={async () => setNotice(await copyText(invitation(crew.invite, 'crew')) ? 'Crew invitation copied. Send it to your friends.' : `Crew invite: ${crew.invite}`)}><Icon name="copy" size={16}/> Invite friends</button>}</div></div>
      <section className="history-section"><h2>Recent matches</h2>{!data?.history.length ? <p className="muted">Your completed ranked matches will appear here.</p> : <div className="history-list">{data.history.slice(0, 8).map(match => <article key={match.id}><Icon name="trophy"/><div><strong>{match.winnerIds.length === 1 ? `${match.players.find(p => p.id === match.winnerIds[0])?.name || 'Player'} won` : 'Draw'}</strong><p>{match.players.map(p => `${p.name} ${p.kills}`).join(' · ')}</p></div><time dateTime={new Date(match.endedAt).toISOString()}>{new Date(match.endedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time></article>)}</div>}</section>
    </>}
  </section>;
}
