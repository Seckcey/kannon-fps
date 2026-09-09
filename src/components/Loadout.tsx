import type { Slot } from '../../shared/protocol';
import { Icon } from './Icon';

export function Loadout({ selected, heals = 2, onSelect, compact = false }: { selected?: Slot; heals?: number; onSelect?: (slot: Slot) => void; compact?: boolean }) {
  return <div className={`loadout ${compact ? 'loadout-compact' : ''}`} aria-label="Fixed loadout">
    {([1, 2, 3] as const).map(slot => {
      const item = slot === 1 ? 'AR' : slot === 2 ? 'Shotgun' : `Heal ×${heals}`;
      return <button type="button" key={slot} className={`loadout-slot ${selected === slot ? 'selected' : ''}`} aria-label={`Slot ${slot}: ${item}`} aria-pressed={onSelect ? selected === slot : undefined}
        onPointerDown={event => {
          if (event.button !== 0) return;
          // Secondary fingers must work while movement/fire owns the first.
          // Select on contact; multi-touch browsers may never produce a click.
          event.preventDefault();
          onSelect?.(slot);
        }}
        onClick={event => {
          // Keep keyboard/assistive activation, without a delayed touch click
          // re-selecting an old slot after a quicker press on another weapon.
          if (event.detail === 0) onSelect?.(slot);
        }} disabled={!onSelect}>
        <span className="slot-number">{slot}</span><Icon name={slot === 1 ? 'ar' : slot === 2 ? 'shotgun' : 'heal'} size={38}/><span className="slot-name">{item}</span>
      </button>;
    })}
  </div>;
}
