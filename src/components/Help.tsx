import { PERKS, STREAKS, STREAK_ORDER, WEAPONS } from '../../shared/weapons';
import { RULES } from '../../shared/protocol';
import { Icon } from './Icon';
import { STREAK_ICONS, WEAPON_ICONS } from './labels';
import { PRESET_INFO } from './loadoutInfo';

export function Help() {
  return <section className="content-page help-page"><div className="page-title"><h1>Make every life count.</h1><p>First person. Five minutes. A new rivalry every round.</p></div>
    <section className="play-options-help"><h2>Find your next game.</h2><p><strong>Play against bots</strong> starts a match with AI rivals and your choice of difficulty. <strong>Available Games</strong> lists public lobbies you can join without an invitation, before the host starts.</p><p>Choose <strong>Create match</strong> for a public or private lobby. Play <strong>Free-for-all</strong> (first to {RULES.ffaScoreLimit} eliminations) or <strong>Team Deathmatch</strong> (two teams, first to {RULES.tdmScoreLimit}). Turn on <strong>Fill to 4 players with bots</strong> to play on your own or with friends. Ranked crew matches are private, human-only and free-for-all.</p></section>
    <div className="help-columns"><section><h2><Icon name="desktop"/> Desktop</h2><dl className="controls-list">
      <div><dt>Move</dt><dd><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></dd></div>
      <div><dt>Look</dt><dd>Mouse</dd></div>
      <div><dt>Fire / aim down sights</dt><dd>Left click / right click</dd></div>
      <div><dt>Sprint / dash</dt><dd><kbd>Shift</kbd> · tap twice and hold to dash</dd></div>
      <div><dt>Crouch / slide</dt><dd><kbd>C</kbd> · while sprinting to slide</dd></div>
      <div><dt>Jump / vault</dt><dd><kbd>Space</kbd> · into a low wall to climb over</dd></div>
      <div><dt>Reload</dt><dd><kbd>R</kbd></dd></div>
      <div><dt>Swap weapons</dt><dd><kbd>Q</kbd>, mouse wheel, <kbd>1</kbd><kbd>2</kbd></dd></div>
      <div><dt>Grenade</dt><dd>Hold <kbd>G</kbd> to cook, let go to throw</dd></div>
      <div><dt>Knife</dt><dd><kbd>V</kbd></dd></div>
      <div><dt>Use a reward</dt><dd><kbd>4</kbd></dd></div>
      <div><dt>Scores / release mouse</dt><dd><kbd>Tab</kbd> / <kbd>Esc</kbd></dd></div>
    </dl></section>
    <section><h2><Icon name="phone"/> Phone</h2><dl className="controls-list">
      <div><dt>Move / sprint</dt><dd>Left stick · push it all the way forward to sprint, again quickly to dash</dd></div>
      <div><dt>Look</dt><dd>Drag the right side</dd></div>
      <div><dt>Fire</dt><dd>Either Fire button · Simple firing also fires when your crosshair rests on a rival</dd></div>
      <div><dt>Aim / crouch / jump</dt><dd>Right-side buttons · Crouch while sprinting to slide</dd></div>
      <div><dt>Grenade</dt><dd>Hold to cook, let go to throw</dd></div>
      <div><dt>Knife / reload / swap</dt><dd>Right-side buttons</dd></div>
      <div><dt>Rewards</dt><dd>Tap a reward button when it appears</dd></div>
      <div><dt>Gyroscope</dt><dd>Enable in Settings to aim by tilting</dd></div>
      <div><dt>Best view</dt><dd>Turn your phone sideways</dd></div>
      <div><dt>Full screen</dt><dd>Android and iPad: tap Ready to play. iPhone: tap Play full screen for the steps</dd></div>
    </dl><p className="muted">Settings let you choose hold or toggle for aim and crouch, how sprint works, your field of view and aim sensitivity. Set graphics to Low if your phone needs a smoother frame rate.</p></section></div>
    <section className="rules-section"><h2>Pick a loadout. Earn your rewards.</h2>
      <div className="help-classes">{(['assault', 'close', 'marksman'] as const).map(preset => <div key={preset}><strong>{PRESET_INFO[preset].name}</strong><p>{PRESET_INFO[preset].summary}</p></div>)}<div><strong>{PRESET_INFO.custom.name}</strong><p>Pick a primary from {Object.values(WEAPONS).filter(w => w.slot === 1).map(w => w.name).join(', ')}, then one perk from each slot, such as {PERKS['quick-hands'].name} or {PERKS['steady-aim'].name}.</p></div></div>
      <div className="help-rewards">{STREAK_ORDER.map(id => <div key={id}><Icon name={STREAK_ICONS[id]} size={30}/><span><strong>{STREAKS[id].kills} in a row · {STREAKS[id].name}</strong><small>{STREAKS[id].description}</small></span></div>)}</div>
      <div className="rule-copy"><p><strong>Health comes back.</strong> You have {RULES.health} health. Stay out of trouble for {RULES.regenDelayMs / 1000} seconds and it refills quickly.</p><p><strong>Quick respawns.</strong> You are back in {RULES.respawnMs / 1000} seconds with full ammo and a frag grenade. Spawn protection lasts {RULES.protectionMs / 1000} seconds and ends when you fire.</p><p><strong>Your crew decides the competition.</strong> Casual and practice matches never change ratings. Ranked crew matches need at least two people and one minute of play. Finish five eligible matches to place; only the first five results against the same opponent each day count.</p></div>
      <p className="muted help-weapons">{Object.values(WEAPONS).map(w => <span key={w.id}><Icon name={WEAPON_ICONS[w.id]} size={22}/>{w.name}</span>)}</p>
    </section>
  </section>;
}
