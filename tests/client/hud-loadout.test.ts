import test from 'node:test';
import assert from 'node:assert/strict';
import type { MedalId, ScoreReason } from '../../shared/protocol.js';
import { DEFAULT_LOADOUT, LOADOUT_PRESET_NAMES, LOADOUT_PRESETS, PERKS, PERK_SLOTS, PRIMARY_WEAPONS, STREAKS, WEAPONS, sanitizeLoadout } from '../../shared/weapons.js';
import { PRESET_INFO, PRESET_ORDER, STAT_LABELS, effectiveRange, loadoutFor, sameLoadout, weaponStats, withPerk, withPrimary } from '../../src/components/loadoutInfo.js';
import { MEDAL_NAMES, MODE_INFO, SCORE_LABELS, TEAM_NAMES, causeIcon, causeName, modeRule, otherTeam } from '../../src/components/labels.js';

test('primary stat bars stay in range and tell the weapons apart', () => {
  for (const id of [...PRIMARY_WEAPONS, 'sentry9'] as const) {
    const stats = weaponStats(WEAPONS[id]);
    for (const [key, value] of Object.entries(stats)) assert.ok(value >= 0.05 && value <= 1, `${id} ${key} = ${value}`);
    assert.deepEqual(Object.keys(stats).sort(), Object.keys(STAT_LABELS).sort());
  }
  const [kr5, hornet, breaker, longbow] = (['kr5', 'hornet9', 'breaker12', 'longbow'] as const).map(id => weaponStats(WEAPONS[id])) as [ReturnType<typeof weaponStats>, ReturnType<typeof weaponStats>, ReturnType<typeof weaponStats>, ReturnType<typeof weaponStats>];
  assert.ok(longbow.range > kr5.range && kr5.range > hornet.range && hornet.range > breaker.range, 'range order');
  assert.ok(hornet.fireRate > kr5.fireRate && kr5.fireRate > breaker.fireRate, 'fire rate order');
  assert.ok(breaker.damage > kr5.damage && longbow.damage >= breaker.damage, 'one-shot weapons hit hardest');
  assert.ok(hornet.mobility > kr5.mobility && kr5.mobility > longbow.mobility, 'mobility order');
  assert.ok(hornet.handling > kr5.handling && kr5.handling > longbow.handling, 'aim speed order');
  assert.ok(Math.abs(effectiveRange(WEAPONS.kr5) - (20 + 20 * 2.8 / 6)) < 1e-9);
  assert.equal(effectiveRange(WEAPONS.longbow), WEAPONS.longbow.maxRange);
});

test('presets and custom classes always resolve to a loadout the server accepts', () => {
  assert.deepEqual(PRESET_ORDER, ['assault', 'close', 'marksman', 'custom']);
  for (const preset of PRESET_ORDER) assert.ok(PRESET_INFO[preset].name && PRESET_INFO[preset].summary);
  assert.equal(PRESET_INFO.close.name, 'Close Quarters');
  for (const preset of ['assault', 'close', 'marksman'] as const) assert.deepEqual(loadoutFor(preset, DEFAULT_LOADOUT), LOADOUT_PRESETS[preset]);
  let custom = withPrimary(DEFAULT_LOADOUT, 'breaker12');
  assert.equal(custom.primary, 'breaker12'); assert.equal(DEFAULT_LOADOUT.primary, 'kr5', 'editing never changes the preset');
  custom = withPerk(custom, 0, 'quick-hands');
  custom = withPerk(custom, 2, 'steady-aim');
  assert.deepEqual(custom.perks, ['quick-hands', 'low-profile', 'steady-aim']);
  assert.equal(withPerk(custom, 1, 'quick-hands'), custom, 'a perk from another slot is ignored');
  assert.deepEqual(sanitizeLoadout(custom), custom);
  assert.deepEqual(loadoutFor('custom', custom), custom);
  assert.deepEqual(loadoutFor('custom', { ...custom, perks: ['quick-hands', 'quick-hands', 'steady-aim'] }), DEFAULT_LOADOUT);
  for (const [slot, choices] of PERK_SLOTS.entries()) for (const perk of choices) assert.equal(withPerk(DEFAULT_LOADOUT, slot as 0 | 1 | 2, perk).perks[slot], perk);
  assert.ok(sameLoadout(LOADOUT_PRESETS.assault, DEFAULT_LOADOUT));
  assert.ok(!sameLoadout(LOADOUT_PRESETS.assault, LOADOUT_PRESETS.close));
});

test('player-facing labels cover every mode, team, medal and score reason', () => {
  const medals: MedalId[] = ['first-strike', 'double', 'triple', 'headshot', 'long-shot', 'even-score', 'blade', 'grenadier', 'drone-down', 'streak-3', 'streak-5', 'streak-7', 'streak-10'];
  for (const medal of medals) assert.ok(MEDAL_NAMES[medal], medal);
  assert.equal(new Set(Object.values(MEDAL_NAMES)).size, medals.length, 'medal names are unique');
  const reasons: ScoreReason[] = ['elimination', 'headshot', 'assist', 'long-shot', 'first-strike', 'even-score', 'multi', 'streak-reward', 'drone-down'];
  for (const reason of reasons) assert.ok(SCORE_LABELS[reason], reason);
  assert.equal(SCORE_LABELS.elimination, 'Elimination'); assert.equal(SCORE_LABELS.headshot, 'Headshot');
  assert.equal(MODE_INFO.ffa.name, 'Free-for-all'); assert.equal(MODE_INFO.tdm.name, 'Team Deathmatch');
  assert.equal(modeRule('ffa'), 'First to 15'); assert.equal(modeRule('tdm'), 'First team to 30'); assert.equal(modeRule('tdm', 20), 'First team to 20');
  assert.equal(TEAM_NAMES.teal, 'Teal'); assert.equal(otherTeam('teal'), 'gold'); assert.equal(otherTeam('gold'), 'teal');
  assert.equal(causeName('bullet', 'hornet9'), 'Hornet 9'); assert.equal(causeName('bullet'), 'Gunfire'); assert.equal(causeName('melee'), 'Knife');
  assert.equal(causeIcon('bullet', 'longbow'), 'sniper'); assert.equal(causeIcon('drone'), 'drone'); assert.equal(causeIcon('mortar'), 'mortar');
});

test('weapon, perk and reward names are our own; names ruled out in review never come back', () => {
  // Only the names players see changed: the ids stay, because saved classes and the network use them.
  assert.equal(WEAPONS.longbow.name, 'Heron 7'); assert.equal(causeName('bullet', 'longbow'), 'Heron 7');
  assert.equal(PERKS['low-profile'].name, 'No Trace'); assert.equal(PERKS['steady-aim'].name, 'Cool Head');
  assert.equal(STREAKS.mortar.name, 'Mortar Volley');
  const shown = [...Object.values(WEAPONS), ...Object.values(PERKS), ...Object.values(STREAKS)].map(item => item.name)
    .concat(Object.values(LOADOUT_PRESET_NAMES), Object.values(MEDAL_NAMES));
  // Each of these is another shooter's name for the same kind of weapon, perk or reward.
  for (const taken of ['Longbow', 'Low Profile', 'Steady Aim', 'Mortar Strike']) assert.ok(!shown.includes(taken), `${taken} is not one of our names`);
});
