import type { CSSProperties } from 'react';
import { STREAKS } from '../../../shared/weapons';
import { Icon } from '../Icon';
import { STREAK_ICONS, TEAM_NAMES, modeRule } from '../labels';
import { TOUCH_CALLOUT, fitCallouts, type Callouts, type FeedEntry, type ScoreSummary } from './match';
import type { Rect } from './touchLayout';

/** Top-centre score and clock: you against your best rival, or team against team. */
export function ScoreBar({ summary, time }: { summary: ScoreSummary; time: string }) {
  if (summary.mode === 'tdm') {
    const fill = (value: number) => ({ transform: `scaleX(${Math.max(0, Math.min(1, value / Math.max(1, summary.limit))).toFixed(3)})` });
    return <div className="score-bar teams" role="group" aria-label={`Your team ${summary.friendly}, other team ${summary.enemy}, ${modeRule('tdm', summary.limit)}`}>
      <div className="score-side friend"><span>{TEAM_NAMES[summary.myTeam]}</span><strong>{summary.friendly}</strong><div className="score-track"><i style={fill(summary.friendly)}/></div></div>
      <div className="score-clock-v3"><time>{time}</time><small>to {summary.limit}</small></div>
      <div className="score-side enemy"><strong>{summary.enemy}</strong><span>{TEAM_NAMES[summary.theirTeam]}</span><div className="score-track"><i style={fill(summary.enemy)}/></div></div>
    </div>;
  }
  return <div className="score-bar" role="group" aria-label={`You ${summary.mine}${summary.rival ? `, ${summary.rival.name} ${summary.rival.kills}` : ''}, ${modeRule('ffa', summary.limit)}`}>
    <div className={`score-side friend ${summary.leading ? 'leading' : ''}`}><span>You</span><strong>{summary.mine}</strong></div>
    <div className="score-clock-v3"><time>{time}</time><small>to {summary.limit}</small></div>
    <div className={`score-side enemy ${summary.leading ? '' : 'leading'}`}><strong>{summary.rival?.kills ?? 0}</strong><span>{summary.rival?.name ?? 'Rivals'}</span></div>
  </div>;
}

/** Recent eliminations. On phones `style` places it under the minimap with only the rows that fit. */
export function KillFeed({ entries, style }: { entries: FeedEntry[]; style?: CSSProperties }) {
  return <div className="kill-feed-v3" aria-live="polite" style={style}>{entries.map(entry => entry.kind === 'elimination'
    ? <div key={entry.key} className="feed-row">
      {entry.attacker && <strong className={`rel-${entry.attacker.relation}`}>{entry.attacker.name}</strong>}
      <span className="feed-weapon" title={entry.weapon}><Icon name={entry.icon} size={20}/>{entry.headshot && <Icon name="head" size={13} className="feed-head"/>}</span>
      <strong className={`rel-${entry.victim.relation}`}>{entry.victim.name}</strong>
      <span className="sr-only">{entry.attacker ? `eliminated with ${entry.weapon}` : 'was eliminated'}{entry.headshot ? ', headshot' : ''}</span>
    </div>
    : <div key={entry.key} className={`feed-row feed-message rel-${entry.tone}`}>{entry.icon && <Icon name={entry.icon} size={16}/>}<span>{entry.text}</span></div>)}
  </div>;
}

/**
 * Threat warnings, medals, score pop-ups and the "reward ready" notice. On desktop the warnings sit under
 * the score bar and the rest under the crosshair, `offset` pixels below the centre. Phones have no room
 * under the crosshair (thumbs and the status panel), so everything stacks in `region` under the score bar,
 * as compact fixed-height lines, keeping only what fits above the crosshair.
 */
export function CombatCallouts({ callouts, touch, region, offset = 86 }: { callouts: Callouts; touch: boolean; region?: Rect; offset?: number }) {
  if (touch && region) {
    const fitted = fitCallouts(callouts, region.h), size = TOUCH_CALLOUT;
    return <div className="callouts touch-callouts" aria-live="polite" style={{ left: region.x, top: region.y, width: region.w, gap: size.gap }}>
      {fitted.notices.map(notice => <span key={notice} className="threat-line" style={{ height: size.notice }}>{notice}</span>)}
      {fitted.medals.map(medal => <div key={medal.key} className="medal-card" style={{ height: size.medal }}><i/><strong>{medal.name}</strong></div>)}
      {fitted.popups.map(popup => <div key={popup.key} className="score-popup" style={{ height: size.popup }}><strong>+{popup.points}</strong><span>{popup.label}</span></div>)}
      {fitted.reward && <div className="reward-ready" style={{ height: size.reward }}><Icon name={STREAK_ICONS[fitted.reward]} size={14}/><strong>{STREAKS[fitted.reward].name} ready</strong></div>}
    </div>;
  }
  const { notices, medals, popups, reward } = callouts;
  return <>
    {notices.length > 0 && <div className="threat-notices" role="status">{notices.map(notice => <span key={notice}>{notice}</span>)}</div>}
    <div className="callouts" aria-live="polite" style={{ ['--callout-offset' as string]: `${Math.round(offset)}px` } as CSSProperties}>
      {medals.map(medal => <div key={medal.key} className="medal-card"><i/><strong>{medal.name}</strong></div>)}
      {popups.length > 0 && <div className="score-popups">{popups.map(popup => <div key={popup.key} className="score-popup"><strong>+{popup.points}</strong><span>{popup.label}</span></div>)}</div>}
      {reward && <div className="reward-ready"><Icon name={STREAK_ICONS[reward]} size={22}/><span><strong>{STREAKS[reward].name} ready</strong><small>{touch ? 'Tap its button to use it.' : 'Press 4 to use it.'}</small></span></div>}
    </div>
  </>;
}
