import type { Score } from '../types';

/**
 * The score indicator: a number from 0 to 100 and nothing else.
 *
 * No letter grade and no tier label anywhere, per §5. A "B+" invites you to feel fine about
 * a site that is invisible to half the agents on the web, and a tier name turns a measurement into
 * a marketing category. The number and the list of what failed are the whole story.
 */
export function ScoreDial({ score }: { score: Score }) {
  const size = 116;
  const stroke = 9;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = Math.max(0, Math.min(100, score.value)) / 100;
  const color = score.value >= 90 ? 'var(--ok)' : score.value >= 60 ? 'var(--warn)' : 'var(--danger)';

  return (
    <div className="score-dial">
      <svg width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * fraction} ${circumference}`}
        />
      </svg>
      <div className="value" style={{ color }}>
        {score.value}
      </div>
      <span className="sr-only">{score.value} out of 100</span>
    </div>
  );
}

export function ScorePanel({ score, url, framework }: { score: Score; url: string; framework?: { name: string } }) {
  return (
    <div className="score">
      <ScoreDial score={score} />
      <div className="score-meta">
        <div className="mono muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>
          {url}
        </div>
        {/* Passed, failed and not applicable always show, the first two because a zero of either is
            worth reading. Partial and locked only when there are some: a site with none of either
            should not be asked to wonder what those words mean. The five together are every check,
            which is the property that makes this row worth trusting. */}
        <div className="counts">
          <span>
            <b>{score.counts.pass}</b> passed
          </span>
          {score.counts.partial > 0 ? (
            <span>
              <b>{score.counts.partial}</b> partly there
            </span>
          ) : null}
          <span>
            <b>{score.counts.fail}</b> failed
          </span>
          {score.counts.locked > 0 ? (
            <span>
              <b>{score.counts.locked}</b> locked
            </span>
          ) : null}
          <span>
            <b>{score.counts.na}</b> not applicable
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12.5 }}>
          {score.earned} of {score.possible} applicable points
          {score.counts.na > 0 ? `, with ${score.counts.na} check${score.counts.na === 1 ? '' : 's'} excluded because ${score.counts.na === 1 ? 'it does' : 'they do'} not apply here` : ''}
          {framework ? ` · ${framework.name} detected` : ''}
        </div>
      </div>
    </div>
  );
}
