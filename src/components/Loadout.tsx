import type { Loadout as LoadoutValue, LoadoutPreset, PrimaryWeaponId } from '../../shared/protocol';
import { LOADOUT_PRESETS, PERKS, PERK_SLOTS, PRIMARY_WEAPONS, WEAPONS } from '../../shared/weapons';
import { Icon } from './Icon';
import { WEAPON_ICONS } from './labels';
import { PRESET_INFO, PRESET_ORDER, STAT_LABELS, WEAPON_KIND_NAMES, loadoutFor, weaponStats, withPerk, withPrimary, type WeaponStats } from './loadoutInfo';
import { Modal } from './Modal';

/** The part of Settings that chooses the class for the next spawn. */
export interface LoadoutChoice { loadoutPreset: LoadoutPreset; customLoadout: LoadoutValue }

/** Three ready-made classes plus a custom one: a primary with stat bars and one perk per slot. */
export function LoadoutPicker({ value, onChange }: { value: LoadoutChoice; onChange: (value: LoadoutChoice) => void }) {
  const custom = value.loadoutPreset === 'custom';
  const loadout = loadoutFor(value.loadoutPreset, value.customLoadout);
  return <div className="loadout-picker">
    <div className="class-tabs" role="radiogroup" aria-label="Class">
      {PRESET_ORDER.map(preset => {
        const primary = preset === 'custom' ? loadoutFor('custom', value.customLoadout).primary : LOADOUT_PRESETS[preset].primary;
        return <button type="button" role="radio" key={preset} aria-checked={value.loadoutPreset === preset} className={value.loadoutPreset === preset ? 'selected' : ''} onClick={() => onChange({ ...value, loadoutPreset: preset })}>
          <Icon name={WEAPON_ICONS[primary]} size={30}/><strong>{PRESET_INFO[preset].name}</strong><small>{WEAPONS[primary].name}</small>
        </button>;
      })}
    </div>
    <p className="class-summary">{PRESET_INFO[value.loadoutPreset].summary}{custom ? '' : ' Pick Custom to choose your own.'}</p>
    {custom
      ? <fieldset className="primary-choices"><legend>Primary weapon</legend>{PRIMARY_WEAPONS.map(id => <label key={id} className={loadout.primary === id ? 'selected' : ''}>
        <input type="radio" name="loadout-primary" checked={loadout.primary === id} onChange={() => onChange({ ...value, customLoadout: withPrimary(loadout, id) })}/><WeaponCard id={id}/>
      </label>)}</fieldset>
      : <div className="primary-card"><WeaponCard id={loadout.primary}/></div>}
    <div className="class-kit">
      <div><span>Secondary</span><strong><Icon name={WEAPON_ICONS[loadout.secondary]} size={22}/>{WEAPONS[loadout.secondary].name}</strong></div>
      <div><span>Lethal</span><strong><Icon name="grenade" size={20}/>Frag grenade</strong></div>
    </div>
    {custom
      ? <div className="perk-slots">{PERK_SLOTS.map((choices, slot) => <fieldset key={slot}><legend>Perk {slot + 1}</legend>{choices.map(perk => <label key={perk} className={loadout.perks[slot] === perk ? 'selected' : ''}>
        <input type="radio" name={`loadout-perk-${slot}`} checked={loadout.perks[slot] === perk} onChange={() => onChange({ ...value, customLoadout: withPerk(loadout, slot as 0 | 1 | 2, perk) })}/>
        <span><strong>{PERKS[perk].name}</strong><small>{PERKS[perk].description}</small></span>
      </label>)}</fieldset>)}</div>
      : <ul className="perk-list" aria-label="Perks">{loadout.perks.map(perk => <li key={perk}><strong>{PERKS[perk].name}</strong><small>{PERKS[perk].description}</small></li>)}</ul>}
  </div>;
}

function WeaponCard({ id }: { id: PrimaryWeaponId }) {
  const spec = WEAPONS[id], stats = weaponStats(spec);
  return <span className="weapon-card">
    <span className="weapon-title"><Icon name={WEAPON_ICONS[id]} size={36}/><span><strong>{spec.name}</strong><small>{WEAPON_KIND_NAMES[spec.kind]} · {spec.magazine} rounds</small></span></span>
    <span className="stat-bars">{(Object.keys(STAT_LABELS) as Array<keyof WeaponStats>).map(key => <span key={key} className="stat-bar">
      <small>{STAT_LABELS[key]}</small><i aria-hidden="true"><b style={{ transform: `scaleX(${stats[key].toFixed(3)})` }}/></i>
    </span>)}</span>
  </span>;
}

/** The chosen class at a glance, with a button to change it. */
export function LoadoutSummary({ value, onEdit, compact = false }: { value: LoadoutChoice; onEdit?: () => void; compact?: boolean }) {
  const loadout = loadoutFor(value.loadoutPreset, value.customLoadout);
  return <div className={`loadout-summary ${compact ? 'compact' : ''}`}>
    <span className="summary-class"><small>Your loadout</small><strong>{PRESET_INFO[value.loadoutPreset].name}</strong></span>
    <span className="summary-kit">
      <span><Icon name={WEAPON_ICONS[loadout.primary]} size={compact ? 26 : 32}/>{WEAPONS[loadout.primary].name}</span>
      <span><Icon name={WEAPON_ICONS[loadout.secondary]} size={20}/>{WEAPONS[loadout.secondary].name}</span>
      <span><Icon name="grenade" size={18}/>Frag</span>
    </span>
    {onEdit && <button type="button" className="button secondary small" onClick={onEdit}><Icon name="class" size={18}/>Change</button>}
  </div>;
}

export function LoadoutDialog({ value, onChange, onClose, inGame = false }: { value: LoadoutChoice; onChange: (value: LoadoutChoice) => void; onClose: () => void; inGame?: boolean }) {
  return <Modal title="Choose your loadout." onClose={onClose} wide>
    <p className="modal-intro">{inGame ? 'Your new loadout is ready the next time you spawn.' : 'You can change it again in the lobby, from the pause menu or while you wait to respawn.'}</p>
    <LoadoutPicker value={value} onChange={onChange}/>
    <button className="button primary full-width" onClick={onClose}>{inGame ? 'Back to game' : 'Done'}</button>
  </Modal>;
}
