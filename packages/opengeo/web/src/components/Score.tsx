import type { HistoryEntry, Score } from '../types';
import { ago } from './ui';

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

  // Locked points sit outside the denominator by construction, so there is no share of *this* ring
  // for them to take. Drawing them into the gap would be a lie twice over: the gap already belongs
  // to the checks that genuinely failed, and the locked share is routinely larger than the gap, so
  // it would have to be clipped to fit and would then read as "the rest is fine".
  //
  // They get their own thread inside instead, sized as the share they would hold if they were being
  // measured. The outer ring says the score is 78; the thread says 78 is not yet the whole picture.
  // Same centre and same axis so the two read as one figure, a third of the weight so neither is
  // mistaken for the other.
  const lockedRadius = radius - stroke / 2 - 4;
  const lockedCircumference = 2 * Math.PI * lockedRadius;
  const locked = lockedShare(score);

  return (
    <div className="score-dial">
      <svg width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        {locked > 0 ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={lockedRadius}
            fill="none"
            stroke="var(--warn)"
            strokeWidth={3}
            strokeOpacity={0.45}
            strokeLinecap="round"
            strokeDasharray={`${lockedCircumference * locked} ${lockedCircumference}`}
          />
        ) : null}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * fraction} ${circumference}`}
          className="score-arc"
        />
      </svg>
      <div className="value" style={{ color }}>
        {score.value}
      </div>
      <span className="sr-only">{score.value} out of 100</span>
    </div>
  );
}

/**
 * How much of a whole ring the locked points would occupy if they were being measured.
 *
 * `possible + locked.points` is the denominator the score would have had if B1 were not failing, so
 * this is the fraction of the real picture that is currently unmeasurable. The same arithmetic the
 * terminal meter uses, deliberately: the two views of one run should not disagree about how big the
 * gap is.
 */
function lockedShare(score: Score): number {
  const whole = score.possible + score.locked.points;
  return whole === 0 ? 0 : score.locked.points / whole;
}

export function ScorePanel({
  score,
  url,
  framework,
  history,
}: {
  score: Score;
  url: string;
  framework?: { name: string };
  /** The runs before this one, so the number can be read as a direction and not just a value. */
  history?: { trend: number[]; previous: HistoryEntry | null };
}) {
  return (
    <div className="score">
      <ScoreDial score={score} />
      <div className="score-meta">
        <div className="score-headline">
          <span className="mono muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>
            {url}
          </span>
          <Delta score={score} previous={history?.previous ?? null} />
          {/* The current score is appended rather than left off: `trend` is the history from before
              this run, and a line that stops one run short tells a different story than the dial
              beside it. Two earlier runs minimum, matching the terminal report, because a line
              through two points is a slope the delta chip has already said in words. */}
          {history && history.trend.length > 1 ? <Sparkline values={[...history.trend, score.value]} /> : null}
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
          {score.locked.points > 0 ? `, and ${score.locked.points} more waiting behind ${score.locked.unlockedBy.join(' and ') || 'one fix'}` : ''}
          {framework ? ` · ${framework.name} detected` : ''}
        </div>
      </div>
    </div>
  );
}

/**
 * The change since the last run of this same URL.
 *
 * Only against the same URL, which is what `previous` already guarantees: a delta between two
 * different sites is a number with no meaning. Nothing is drawn when the score has not moved, since
 * "+0" is noise, and nothing is drawn on a first run, which is most runs.
 */
function Delta({ score, previous }: { score: Score; previous: HistoryEntry | null }) {
  if (!previous || previous.score === undefined) return null;
  const change = score.value - previous.score;
  if (change === 0) return null;
  return (
    <span className={`delta ${change > 0 ? 'delta-up' : 'delta-down'}`}>
      {change > 0 ? '+' : ''}
      {change} since {ago(previous.at)}
    </span>
  );
}

/**
 * The last few runs as one small line.
 *
 * Scaled to its own range rather than to 0-100, so a site that has been sitting between 94 and 98
 * shows a shape instead of a flat line at the top. That makes the height meaningless in absolute
 * terms, which is why there is no axis and no label: it is a direction, and the number beside it is
 * the measurement.
 */
function Sparkline({ values }: { values: number[] }) {
  const width = 56;
  const height = 16;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - (span === 0 ? 0.5 : (value - low) / span) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg className="sparkline" width={width} height={height} aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
