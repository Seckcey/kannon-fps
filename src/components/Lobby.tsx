import { useState } from 'react';
import type { RoomSnapshot } from '../../shared/protocol';
import { copyText, invitation } from '../lib/storage';
import { Icon } from './Icon';
import { Loadout } from './Loadout';
import { practiceLevelName } from '../lib/practice';

export function Lobby({ room, playerId, onStart, onLeave, busy }: { room: RoomSnapshot; playerId: string; onStart: () => void; onLeave: () => void; busy: boolean }) {
  const [copied, setCopied] = useState(false);
  const people = room.players.filter(p => !p.bot);
  const host = room.hostId === playerId;
  const canStart = room.practice || people.filter(p => p.connected).length >= 2;
  return <section className="room-lobby"><div className="lobby-copy"><button className="text-button back-button" onClick={onLeave}><Icon name="leave" size={18}/> Leave room</button><h1>{room.practice ? 'Find your rhythm.' : 'Bring your rivals.'}</h1><p>{room.practice ? 'Meet Sunbreak. Three AI rivals. A real round to sharpen your game.' : 'One invitation. Your whole crew. The next round is yours.'}</p>
    {!room.practice && <div className="invite-panel"><span className="field-label">Private room code</span><strong className="room-code">{room.code}</strong><button className="button primary" onClick={async () => { const ok = await copyText(invitation(room.code)); setCopied(ok); }}><Icon name={copied ? 'check' : 'copy'} size={20}/>{copied ? 'Invitation copied' : 'Copy match invitation'}</button><p>Share the link or this code. Invitations expire after two hours.</p></div>}
    <div className="match-summary"><div><span>Arena</span><strong>Sunbreak Courtyard</strong></div><div><span>Mode</span><strong>{room.practice ? `${practiceLevelName(room.practiceDifficulty)} practice` : room.ranked ? 'Ranked crew match' : 'Casual free-for-all'}</strong></div><div><span>Rules</span><strong>5 minutes · First to 15</strong></div></div>
    <Loadout compact/>
  </div><div className="roster-panel"><div className="roster-heading"><h2>{room.practice ? 'Your practice rivals' : 'In the room'}</h2><span>{room.practice ? 'You + 3 AI rivals' : `${people.length} / 8`}</span></div><ul className="roster-list">{room.players.map(p => <li key={p.id}><div className="player-avatar" style={{ '--player-color': p.color } as React.CSSProperties}><Icon name={p.bot ? 'target' : 'shield'} size={24}/></div><div><strong>{p.name}</strong><span>{p.bot ? 'AI opponent' : p.id === room.hostId ? 'Room host' : 'Ready to play'}{p.id === playerId ? ' · You' : ''}</span></div><span className={`online-dot ${p.connected ? '' : 'offline'}`} title={p.connected ? 'Connected' : 'Reconnecting'}/></li>)}</ul>
    {!room.practice && people.length < 8 && <div className="roster-empty"><Icon name="users" size={28}/><p>{people.length < 2 ? 'Your rival’s spot is waiting.' : 'Room for more friends.'}</p></div>}
    <div className="lobby-start">{host ? <><button className="button primary full-width" disabled={!canStart || busy} onClick={onStart}><Icon name="play"/>{busy ? 'Starting…' : room.practice ? 'Enter practice' : 'Start match'}</button><p>{canStart ? 'Same loadout. A fresh start for everyone.' : 'Invite at least one friend to start.'}</p></> : <div className="waiting-message"><span className="loading-dot"/><strong>Waiting for the host to start</strong><p>You’re connected and ready.</p></div>}</div>
  </div></section>;
}
