import type { Crew, PracticeDifficulty, RoomVisibility } from '../../shared/protocol';
import { PRACTICE_LEVELS } from '../lib/practice';
import { Icon } from './Icon';
import { Modal } from './Modal';

export function CreateMatchDialog({ visibility, onVisibility, ranked, onRanked, fillBots, onFillBots, botDifficulty, onBotDifficulty, crews, selectedCrew, onCrew, onSetupCrew, onClose, onCreate, busy, preparingArt, error }: {
  visibility: RoomVisibility; onVisibility: (value: RoomVisibility) => void;
  ranked: boolean; onRanked: (value: boolean) => void; fillBots: boolean; onFillBots: (value: boolean) => void;
  botDifficulty: PracticeDifficulty; onBotDifficulty: (value: PracticeDifficulty) => void;
  crews: Crew[]; selectedCrew: string; onCrew: (value: string) => void;
  onSetupCrew: () => void; onClose: () => void; onCreate: () => void;
  busy: boolean; preparingArt: boolean; error: string;
}) {
  return <Modal title="Create your match." onClose={onClose}>
    <p className="modal-intro">Choose who can join your Kannon Town free-for-all.</p>
    <fieldset className="room-visibility"><legend>Who can join?</legend>
      <label className={visibility === 'private' ? 'selected' : ''}><input type="radio" name="visibility" checked={visibility === 'private'} onChange={() => onVisibility('private')} disabled={busy}/><span><strong>Private</strong><small>Only people with your invitation.</small></span></label>
      <label className={visibility === 'public' ? 'selected' : ''}><input type="radio" name="visibility" checked={visibility === 'public'} onChange={() => { onVisibility('public'); onRanked(false); }} disabled={busy}/><span><strong>Public</strong><small>Anyone can find and join your lobby in Available Games.</small></span></label>
    </fieldset>
    {visibility === 'private' && <div className="match-choice"><button disabled={busy} aria-pressed={!ranked} className={!ranked ? 'selected' : ''} onClick={() => onRanked(false)}><Icon name="users"/><strong>Casual</strong><span>Just play. No ratings.</span></button><button disabled={busy} aria-pressed={ranked} className={ranked ? 'selected' : ''} onClick={() => onRanked(true)}><Icon name="trophy"/><strong>Ranked</strong><span>Human crew members only.</span></button></div>}
    {!ranked && <div className="bot-setup"><label className="bot-toggle"><input type="checkbox" checked={fillBots} onChange={event => onFillBots(event.target.checked)} disabled={busy}/><span><strong>Fill to 4 players with bots</strong><small>Start on your own. People replace bots as they join the lobby.</small></span></label>{fillBots && <div><label className="field-label" htmlFor="bot-difficulty">Bot difficulty</label><select id="bot-difficulty" value={botDifficulty} onChange={event => onBotDifficulty(event.target.value as PracticeDifficulty)} disabled={busy}>{PRACTICE_LEVELS.map(level => <option key={level.id} value={level.id}>{level.name}</option>)}</select></div>}</div>}
    {ranked && <div className="ranked-setup">{crews.length ? <label className="field-label">Choose your crew<select disabled={busy} value={selectedCrew} onChange={event => onCrew(event.target.value)}>{crews.map(crew => <option key={crew.id} value={crew.id}>{crew.name}</option>)}</select><small>Everyone joining must belong to this crew.</small></label> : <p>Create a friend crew on the Leaderboard first. <button className="text-button" disabled={busy} onClick={onSetupCrew}>Set up your crew <Icon name="arrow" size={15}/></button></p>}</div>}
    <div className="modal-rule-line">{!ranked && fillBots ? '1–8 people + AI as needed' : '2–8 people'} · 5 minutes · First to 15</div>
    {error && <p className="error-message" role="alert">{error}</p>}
    <button className="button primary full-width" disabled={busy || (ranked && !selectedCrew)} onClick={onCreate}><Icon name="play"/>{preparingArt ? 'Preparing arena…' : busy ? 'Creating room…' : visibility === 'public' ? 'Create public game' : 'Create private game'}</button>
  </Modal>;
}
