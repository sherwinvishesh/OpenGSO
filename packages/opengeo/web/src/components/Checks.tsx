import type { CheckResult } from '../types';
import { Card, CardHead, Empty, Pill } from './ui';

/**
 * Failures first, required before recommended, per idea.md §5. The order is the point: someone who
 * reads only the first group has read the things that actually stop agents working.
 */

const DOCS = 'https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/checks.md';

export function CheckList({ checks }: { checks: CheckResult[] }) {
  const failedRequired = checks.filter((check) => check.status === 'fail' && check.importance === 'required');
  const failedRecommended = checks.filter((check) => check.status === 'fail' && check.importance === 'recommended');
  const passed = checks.filter((check) => check.status === 'pass');
  const na = checks.filter((check) => check.status === 'na');

  return (
    <div>
      <Group
        title="Failed - required"
        tone="fail"
        checks={failedRequired}
        empty="Nothing required is failing."
        note="These stop AI agents from reading the page."
      />
      <Group
        title="Failed - recommended"
        tone="warn"
        checks={failedRecommended}
        empty="Nothing recommended is failing."
        note="These make things better, but nothing here is broken."
      />
      <Group title="Passed" tone="ok" checks={passed} empty="Nothing passed yet." />
      <Group
        title="Not applicable"
        tone="mute"
        checks={na}
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

function CheckRow({ check }: { check: CheckResult }) {
  return (
    <div className="check">
      <div className="check-id">
        <a href={`${DOCS}#${check.id.toLowerCase()}---${slug(check.title)}`} target="_blank" rel="noreferrer" title="What this check verifies">
          {check.id}
        </a>
      </div>
      <div>
        <div className="check-title">{check.title}</div>
        <div className="check-reason">{check.reason}</div>
        {check.detail ? <div className="check-detail">{check.detail}</div> : null}
      </div>
      <div className="check-points">
        {check.status === 'fail' ? `-${check.weight}` : check.status === 'na' ? 'n/a' : `${check.weight}`}
      </div>
    </div>
  );
}

/** Matches the heading anchors GitHub generates for docs/checks.md. */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/ /g, '-');
}
