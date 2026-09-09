import { useState } from 'react';
import type { CheckResult, Score } from '../types';
import { Card, Empty, Pill } from './ui';

/**
 * Failures first, required before recommended, per §5. The order is the point: someone who
 * reads only the first group has read the things that actually stop agents working.
 *
 * Six groups rather than four, because two statuses had nowhere to go. A partial fell through every
 * filter and vanished from the page entirely while still counting in the score, and the twin cascade
 * arrived as thirteen separate rows each explaining that a document which does not exist cannot be
 * inspected. Both now have a home, and the locked one is a single priced card rather than thirteen
 * shrugs.
 */

const DOCS = 'https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/checks.md';

export function CheckList({ checks, score }: { checks: CheckResult[]; score?: Score }) {
  const of = (status: CheckResult['status']) => checks.filter((check) => check.status === status);
  const failed = of('fail');

  return (
    <div>
      <Group
        title="Failed - required"
        tone="fail"
        checks={failed.filter((check) => check.importance === 'required')}
        empty="Nothing required is failing."
        note="These stop AI agents from reading the page."
      />
      <Group
        title="Failed - recommended"
        tone="warn"
        checks={failed.filter((check) => check.importance === 'recommended')}
        empty="Nothing recommended is failing."
        note="These make things better, but nothing here is broken."
      />
      <Group
        title="Partly there"
        tone="warn"
        checks={of('partial')}
        empty=""
        note="Scored on what they earned, not all or nothing."
      />
      <LockedGroup checks={of('locked')} score={score} />
      <Group title="Passed" tone="ok" checks={of('pass')} empty="Nothing passed yet." />
      <Group
        title="Not applicable"
        tone="mute"
        checks={of('na')}
        empty=""
        note="Excluded from the score entirely, not counted as failures."
      />
    </div>
  );
}

function Group({
  title,
  tone,
  checks,
  empty,
  note,
}: {
  title: string;
  tone: 'ok' | 'fail' | 'warn' | 'mute';
  checks: CheckResult[];
  empty: string;
  note?: string;
}) {
  if (checks.length === 0 && !empty) return null;
  return (
    <div className="check-group">
      <h3 className="group-title">
        {title}
        <Pill tone={tone}>{checks.length}</Pill>
        {note && checks.length > 0 ? <span style={{ textTransform: 'none', letterSpacing: 0 }}>{note}</span> : null}
      </h3>
      <Card>
        {checks.length === 0 ? (
          <Empty title={empty} />
        ) : (
          checks.map((check) => <CheckRow key={check.id} check={check} />)
        )}
      </Card>
    </div>
  );
}

/**
 * The twin cascade, as one priced card.
 *
 * This is the group the `locked` status exists for. Thirteen rows each saying that a document which
 * does not exist cannot be inspected is not information; the same thirteen, summed and labelled with
 * the one thing that unlocks them, is. Collapsed by default and expandable, because the detail is
 * worth having exactly once and never on the way past.
 */
function LockedGroup({ checks, score }: { checks: CheckResult[]; score?: Score }) {
  const [open, setOpen] = useState(false);
  if (checks.length === 0) return null;

  const waiting = score?.locked.points ?? checks.reduce((total, check) => total + check.weight, 0);
  const blockers = score?.locked.unlockedBy ?? [];
  const blocker = blockers[0] ?? checks[0]?.lockedBy;

  return (
    <div className="check-group">
      <h3 className="group-title">
        Locked
        <Pill tone="mute">{checks.length}</Pill>
        <span style={{ textTransform: 'none', letterSpacing: 0 }}>
          Not failures. Not measurable yet either, so they are outside the score.
        </span>
      </h3>
      <Card>
        <div className="card-pad stack-sm">
          <div className="locked-head">
            <b className="locked-points">{waiting} points</b>
            <span className="muted">waiting behind {blockers.join(' and ') || 'one fix'}</span>
          </div>
          {blocker === 'B1' ? (
            <p className="muted" style={{ margin: 0 }}>
              Serve a markdown twin at the <span className="mono">.md</span> URL and every one of
              these becomes measurable. <span className="mono">opengeo generate</span> writes the
              files, <span className="mono">opengeo prod</span> serves them.
            </p>
          ) : null}
          <div className="locked-prices">
            {checks.map((check) => (
              <span key={check.id} className="locked-price">
                <b>{check.id}</b> {check.weight}
              </span>
            ))}
          </div>
          <button type="button" className="link-btn" onClick={() => setOpen((current) => !current)}>
            {open ? 'Hide the detail' : `Why each of the ${checks.length} is locked`}
          </button>
        </div>
        {open ? checks.map((check) => <CheckRow key={check.id} check={check} />) : null}
      </Card>
    </div>
  );
}

function CheckRow({ check }: { check: CheckResult }) {
  return (
    <div className="check">
      <div className="check-id">
        <a href={`${DOCS}#${check.id.toLowerCase()}---${slug(check.title)}`} target="_blank" rel="noreferrer" title="What this check verifies">
          {check.id}
        </a>
      </div>
      <div>
        <div className="check-title">
          {check.title}
          {/* A partial carries its arithmetic, because "partly there" with no number is a mood
              rather than a measurement. */}
          {check.status === 'partial' ? (
            <span className="check-meter" title={`${check.earned} of ${check.weight} points`}>
              <span className="check-meter-track">
                <span className="check-meter-fill" style={{ width: `${(check.earned / check.weight) * 100}%` }} />
              </span>
              {check.earned} of {check.weight}
            </span>
          ) : null}
        </div>
        <div className="check-reason">{check.reason}</div>
        {check.detail ? <div className="check-detail">{check.detail}</div> : null}
        {/* Last, and only when there is one, because it is the part the reader acts on. */}
        {check.fix ? <div className="check-fix">{check.fix}</div> : null}
      </div>
      <div className="check-points">{points(check)}</div>
    </div>
  );
}

/** What the check is doing to the score, in the fewest characters that stay honest. */
function points(check: CheckResult): string {
  if (check.status === 'fail') return `-${check.weight}`;
  if (check.status === 'partial') return `${check.earned}/${check.weight}`;
  if (check.status === 'locked') return `${check.weight}`;
  if (check.status === 'na') return 'n/a';
  return `${check.weight}`;
}

/** Matches the heading anchors GitHub generates for docs/checks.md. */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/ /g, '-');
}
