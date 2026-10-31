import { useState } from 'react';
import { hasMatchOpponents, type RoomPlayer, type RoomSnapshot, type Team } from '../../shared/protocol';
import { copyText, invitation, shareInvitation, type ShareOutcome } from '../lib/storage';
import { Icon } from './Icon';
import { LoadoutSummary, type LoadoutChoice } from './Loadout';
import { MODE_INFO, TEAM_NAMES, modeRule } from './labels';
import { practiceLevelName } from '../lib/practice';

function RosterRow({ person, room, playerId }: { person: RoomPlayer; room: RoomSnapshot; playerId: string }) {
  return <li><div className="player-avatar" style={{ '--player-color': person.color } as React.CSSProperties}><Icon name={person.bot ? 'target' : 'shield'} size={24}/></div><div><strong>{person.name}</strong><span>{person.bot ? 'AI opponent' : person.id === room.hostId ? 'Room host' : 'In the lobby'}{person.id === playerId ? ' · You' : ''}</span></div><span className={`online-dot ${person.connected ? '' : 'offline'}`} title={person.connected ? 'Connected' : 'Reconnecting'}/></li>;
}

export function Lobby({ room, playerId, onStart, onLeave, busy, loadout, onEditLoadout }: { room: RoomSnapshot; playerId: string; onStart: () => void; onLeave: () => void; busy: boolean; loadout: LoadoutChoice; onEditLoadout: () => void }) {
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState<ShareOutcome>(false);
  const [sharing, setSharing] = useState(false);
  const people = room.players.filter(p => !p.bot);
  const bots = room.players.filter(p => p.bot);
  const isPublic = room.visibility === 'public';
  const host = room.hostId === playerId;
  const canStart = hasMatchOpponents(room.players);
  const mode = room.mode ?? 'ffa';
  const myTeam = room.players.find(p => p.id === playerId)?.team;
  type TeamGroup = { key: string; team?: Team; players: RoomPlayer[] };
  const order: Team[] = myTeam === 'gold' ? ['gold', 'teal'] : ['teal', 'gold'];
  const teams: TeamGroup[] = mode === 'tdm'
    ? [...order.map((team): TeamGroup => ({ key: team, team, players: room.players.filter(p => p.team === team) })),
      { key: 'none', players: room.players.filter(p => !p.team) } as TeamGroup].filter(group => group.team || group.players.length)
    : [{ key: 'all', players: room.players }];
  return <section className="room-lobby"><div className="lobby-copy"><button className="text-button back-button" onClick={onLeave}><Icon name="leave" size={18}/> Leave room</button><h1>{room.practice ? 'Meet your bot rivals.' : isPublic ? 'Your lobby is open.' : 'Bring your rivals.'}</h1><p>{room.practice ? (mode === 'tdm' ? 'You and an AI teammate against two AI rivals. A full match whenever you want to play.' : 'Three AI rivals. A full match whenever you want to play.') : isPublic ? 'Players can find this lobby in Available Games and join without an invitation. Start when you are ready.' : room.fillBots ? 'Invite friends or start with AI rivals. People replace bots as they join the lobby.' : 'Share an invitation and start when your friends have joined.'}</p>
    {!room.practice && <div className="invite-panel"><span className="field-label">{isPublic ? 'Public room code' : 'Private room code'}</span><strong className="room-code">{room.code}</strong><div className="invite-actions"><button className="button primary" disabled={sharing} onClick={async () => { setSharing(true); setCopied(false); try { setShared(await shareInvitation(room.code)); } finally { setSharing(false); } }}><Icon name={shared === 'shared' || shared === 'copied' ? 'check' : 'link'} size={20}/>{sharing ? 'Sharing…' : shared === 'shared' ? 'Invitation sent' : shared === 'copied' ? 'Invitation copied' : 'Share with friends'}</button><button className="button secondary" onClick={async () => { const ok = await copyText(invitation(room.code)); setShared(false); setCopied(ok); }}><Icon name={copied ? 'check' : 'copy'} size={20}/>{copied ? 'Link copied' : 'Copy link'}</button></div><p>{isPublic ? 'Sharing is optional. Anyone can join from Available Games before the match starts.' : 'Share with friends sends the invite poster and link. This room is hidden from Available Games.'} Rooms expire after two hours.</p></div>}
    <div className="match-summary"><div><span>Arena</span><strong>Kannon Town</strong></div><div><span>Mode</span><strong>{MODE_INFO[mode].name} · {room.practice ? `${practiceLevelName(room.practiceDifficulty)} bot match` : room.ranked ? 'Ranked crew match' : `${isPublic ? 'Public' : 'Private'} casual`}</strong></div>{room.fillBots && <div><span>Bots</span><strong>{practiceLevelName(room.botDifficulty)} · Fill to 4 players</strong></div>}<div><span>Rules</span><strong>5 minutes · {modeRule(mode)}</strong></div></div>
    <LoadoutSummary value={loadout} onEdit={onEditLoadout}/>
  </div><div className="roster-panel"><div className="roster-heading"><h2>{room.practice ? (mode === 'tdm' ? 'Your teams' : 'Your bot rivals') : mode === 'tdm' ? 'Teams' : 'In the room'}</h2><span>{room.practice ? 'You + 3 AI' : `${people.length} / 8 people${bots.length ? ` + ${bots.length} AI` : ''}`}</span></div>
    {teams.map(group => <div key={group.key} className={`roster-team ${group.team ? `team-${group.team}` : ''} ${group.team && myTeam ? (group.team === myTeam ? 'rel-friend' : 'rel-enemy') : ''}`}>
      {mode === 'tdm' && <h3>{group.team ? `${TEAM_NAMES[group.team]} team` : 'Joining a team'}{group.team && group.team === myTeam ? <span>Your team</span> : null}</h3>}
      <ul className="roster-list">{group.players.map(p => <RosterRow key={p.id} person={p} room={room} playerId={playerId}/>)}{mode === 'tdm' && !group.players.length && <li className="roster-open">Open spot</li>}</ul>
    </div>)}
    {!room.practice && people.length < 8 && <div className="roster-empty"><Icon name="users" size={28}/><p>{room.fillBots ? 'People replace bots in the lobby.' : isPublic ? 'Waiting for more players to join.' : 'Room for more friends.'}</p></div>}
    <div className="lobby-start">{host ? <><button className="button primary full-width" disabled={!canStart || busy} onClick={onStart}><Icon name="play"/>{busy ? 'Starting…' : room.practice ? 'Enter bot match' : 'Start match'}</button><p>{canStart ? 'Everyone selects Ready to play after the arena loads.' : isPublic ? 'Wait for another player to join before starting.' : 'Invite at least one friend to start.'}</p></> : <div className="waiting-message"><span className="loading-dot"/><strong>Waiting for the host to start</strong><p>You’re connected. You’ll select Ready to play after the arena loads.</p></div>}</div>
  </div></section>;
}
