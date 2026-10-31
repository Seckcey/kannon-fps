import type { CSSProperties, ReactNode } from 'react';
import type { GameMode } from '../../../shared/protocol';
import { Icon } from '../Icon';
import { MODE_INFO, modeRule } from '../labels';
import type { MatchResult, ScoreGroup } from './match';

export interface ResultSummary { result: MatchResult; detail: string; topScorer: { name: string; score: number } | null }

/** Standings during play (hold Tab, or the phone's standings button), and the results screen at the end.
 * During play the game stays visible and unblurred; `panelStyle` places the phone panel between the thumbs. */
export function Scoreboard({ groups, mode, limit, result, onClose, live = false, panelStyle, children }: {
  groups: ScoreGroup[]; mode: GameMode; limit: number; result?: ResultSummary; onClose?: () => void;
  live?: boolean; panelStyle?: CSSProperties; children?: ReactNode;
}) {
  return <div className={`scoreboard-overlay ${result ? 'results' : ''} ${live ? 'live' : ''} ${panelStyle ? 'placed' : ''}`}>
    <div className={`scoreboard-panel scoreboard-v3 ${mode === 'tdm' ? 'teams' : ''} ${result ? `outcome-${result.result.outcome}` : ''}`} style={panelStyle}
      role={result ? 'dialog' : 'region'} aria-label={result ? 'Match results' : 'Match standings'}>
      {result ? <header className="results-header">
        <Icon name="trophy" size={38}/>
        <h1>{result.result.title}</h1>
        <p>{result.detail}</p>
        {result.topScorer && <p className="top-scorer"><span>Top scorer</span><strong>{result.topScorer.name}</strong><b>{result.topScorer.score.toLocaleString()}</b></p>}
      </header> : <header className="standings-header"><h2>Match standings</h2><span>{MODE_INFO[mode].name} · {modeRule(mode, limit)}</span>{onClose && <button className="icon-button" aria-label="Close standings" onClick={onClose}><Icon name="close" size={20}/></button>}</header>}
      <div className="score-groups">{groups.map(group => <section key={group.key} className={`score-group group-${group.relation}`}>
        {(group.total !== null || mode === 'tdm') && <h3><span>{group.title}{group.relation === 'friend' ? ' · Your team' : ''}</span>{group.total !== null && <strong>{group.total}</strong>}</h3>}
        <table>
          <thead><tr><th scope="col">Player</th><th scope="col">Score</th><th scope="col" title="Eliminations">Elims</th><th scope="col">Deaths</th><th scope="col">Assists</th></tr></thead>
          <tbody>{group.rows.length ? group.rows.map(row => <tr key={row.id} className={`${row.relation === 'self' ? 'you-row' : ''} ${row.connected ? '' : 'offline-row'}`}>
            <td><span className="player-dot" style={{ background: row.color }}/><span className={`row-name ${row.relation === 'self' || mode === 'tdm' ? `rel-${row.relation}` : ''}`}>{row.name}</span>{row.relation === 'self' && <span className="you-label">You</span>}{row.bot && <span className="bot-label">AI</span>}</td>
            <td className="score-cell">{row.score.toLocaleString()}</td><td>{row.kills}</td><td>{row.deaths}</td><td>{row.assists}</td>
          </tr>) : <tr><td colSpan={5} className="table-empty">No players yet</td></tr>}</tbody>
        </table>
      </section>)}</div>
      {/* Results keep their buttons in view on short screens; only the standings scroll. */}
      {children && <footer className="scoreboard-actions">{children}</footer>}
    </div>
  </div>;
}
