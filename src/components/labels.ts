import { RULES, type DamageCause, type GameMode, type MedalId, type ScoreReason, type StreakId, type Team, type WeaponId } from '../../shared/protocol';
import { WEAPONS } from '../../shared/weapons';
import type { IconName } from './Icon';

/** Player-facing names. Weapon, perk and reward names come from shared/weapons.ts. */
export const MODE_INFO: Record<GameMode, { name: string; summary: string }> = {
  ffa: { name: 'Free-for-all', summary: 'Everyone for themselves.' },
  tdm: { name: 'Team Deathmatch', summary: 'Two teams. Work together to win.' },
};
export function modeRule(mode: GameMode, limit?: number): string {
  return mode === 'tdm' ? `First team to ${limit ?? RULES.tdmScoreLimit}` : `First to ${limit ?? RULES.ffaScoreLimit}`;
}
export const TEAM_NAMES: Record<Team, string> = { teal: 'Teal', gold: 'Gold' };
export const otherTeam = (team: Team): Team => team === 'teal' ? 'gold' : 'teal';

export const MEDAL_NAMES: Record<MedalId, string> = {
  'first-strike': 'First Strike', double: 'Double Up', triple: 'Triple Up', headshot: 'Bullseye', 'long-shot': 'Long Range',
  'even-score': 'Evened Up', blade: 'Quick Blade', grenadier: 'Well Thrown', 'drone-down': 'Drone Down',
  'streak-3': 'Three Straight', 'streak-5': 'Five Straight', 'streak-7': 'Seven Straight', 'streak-10': 'Ten Straight',
};
export const SCORE_LABELS: Record<ScoreReason, string> = {
  elimination: 'Elimination', headshot: 'Headshot', assist: 'Assist', 'long-shot': 'Long range', 'first-strike': 'First strike',
  'even-score': 'Evened up', multi: 'Combo', 'streak-reward': 'Reward', 'drone-down': 'Drone down',
};
export const WEAPON_ICONS: Record<WeaponId, IconName> = { kr5: 'ar', hornet9: 'smg', breaker12: 'shotgun', longbow: 'sniper', sentry9: 'pistol' };
export const STREAK_ICONS: Record<StreakId, IconName> = { recon: 'radar', mortar: 'mortar', drone: 'drone' };

/** What eliminated someone, for the kill feed and the "eliminated by" card. */
export function causeName(cause: DamageCause, weapon?: WeaponId): string {
  if (cause === 'bullet') return weapon ? WEAPONS[weapon].name : 'Gunfire';
  return { melee: 'Knife', frag: 'Frag grenade', mortar: 'Mortar Strike', drone: 'Attack Drone' }[cause];
}
export function causeIcon(cause: DamageCause, weapon?: WeaponId): IconName {
  if (cause === 'bullet') return weapon ? WEAPON_ICONS[weapon] : 'target';
  return ({ melee: 'knife', frag: 'grenade', mortar: 'mortar', drone: 'drone' } as const)[cause];
}
