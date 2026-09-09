import { useState } from 'react';
import { hasMatchOpponents, type RoomSnapshot } from '../../shared/protocol';
import { copyText, invitation } from '../lib/storage';
import { Icon } from './Icon';
import { Loadout } from './Loadout';
import { practiceLevelName } from '../lib/practice';

export function Lobby({ room, playerId, onStart, onLeave, busy }: { room: RoomSnapshot; playerId: string; onStart: () => void; onLeave: () => void; busy: boolean }) {
  const [copied, setCopied] = useState(false);
  const people = room.players.filter(p => !p.bot);
  const bots = room.players.filter(p => p.bot);
  const isPublic = room.visibility === 'public';
  const host = room.hostId === playerId;
  const canStart = hasMatchOpponents(room.players);
  return <section className="room-lobby"><div className="lobby-copy"><button className="text-button back-button" onClick={onLeave}><Icon name="leave" size={18}/> Leave room</button><h1>{room.practice ? 'Meet your bot rivals.' : isPublic ? 'Your lobby is open.' : 'Bring your rivals.'}</h1><p>{room.practice ? 'Three AI rivals. A full match whenever you want to play.' : isPublic ? 'Players can find this lobby in Available Games and join without an invitation. Start when you are ready.' : room.fillBots ? 'Invite friends or start with AI rivals. People replace bots as they join the lobby.' : 'Share an invitation and start when your friends have joined.'}</p>
    {!room.practice && <div className="invite-panel"><span className="field-label">{isPublic ? 'Public room code' : 'Private room code'}</span><strong className="room-code">{room.code}</strong><button className="button primary" onClick={async () => { const ok = await copyText(invitation(room.code)); setCopied(ok); }}><Icon name={copied ? 'check' : 'copy'} size={20}/>{copied ? 'Invitation copied' : 'Copy match invitation'}</button><p>{isPublic ? 'Sharing is optional. Anyone can join from Available Games before the match starts.' : 'Share the link or this code. This room is hidden from Available Games.'} Rooms expire after two hours.</p></div>}
    <div className="match-summary"><div><span>Arena</span><strong>Kannon Town</strong></div><div><span>Mode</span><strong>{room.practice ? `${practiceLevelName(room.practiceDifficulty)} bot match` : room.ranked ? 'Ranked crew match' : `${isPublic ? 'Public' : 'Private'} casual match`}</strong></div>{room.fillBots && <div><span>Bots</span><strong>{practiceLevelName(room.botDifficulty)} · Fill to 4 players</strong></div>}<div><span>Rules</span><strong>5 minutes · First to 15</strong></div></div>
    <Loadout compact/>
  </div><div className="roster-panel"><div className="roster-heading"><h2>{room.practice ? 'Your bot rivals' : 'In the room'}</h2><span>{room.practice ? 'You + 3 AI rivals' : `${people.length} / 8 people${bots.length ? ` + ${bots.length} AI` : ''}`}</span></div><ul className="roster-list">{room.players.map(p => <li key={p.id}><div className="player-avatar" style={{ '--player-color': p.color } as React.CSSProperties}><Icon name={p.bot ? 'target' : 'shield'} size={24}/></div><div><strong>{p.name}</strong><span>{p.bot ? 'AI opponent' : p.id === room.hostId ? 'Room host' : 'In the lobby'}{p.id === playerId ? ' · You' : ''}</span></div><span className={`online-dot ${p.connected ? '' : 'offline'}`} title={p.connected ? 'Connected' : 'Reconnecting'}/></li>)}</ul>
    {!room.practice && people.length < 8 && <div className="roster-empty"><Icon name="users" size={28}/><p>{room.fillBots ? 'People replace bots in the lobby.' : isPublic ? 'Waiting for more players to join.' : 'Room for more friends.'}</p></div>}
    <div className="lobby-start">{host ? <><button className="button primary full-width" disabled={!canStart || busy} onClick={onStart}><Icon name="play"/>{busy ? 'Starting…' : room.practice ? 'Enter bot match' : 'Start match'}</button><p>{canStart ? 'Everyone selects Ready to play after the arena loads.' : isPublic ? 'Wait for another player to join before starting.' : 'Invite at least one friend to start.'}</p></> : <div className="waiting-message"><span className="loading-dot"/><strong>Waiting for the host to start</strong><p>You’re connected. You’ll select Ready to play after the arena loads.</p></div>}</div>
  </div></section>;
}
