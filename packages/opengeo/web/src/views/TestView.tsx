import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type {
  ApiProgress,
  ContentReview,
  DocumentReview,
  HistoryEntry,
  QualityRecommendation,
  State,
  TestMode,
  TestResponse,
} from '../types';
import { CheckList } from '../components/Checks';
import { RunProgress } from '../components/Progress';
import { ScorePanel } from '../components/Score';
import { ago, Banner, Button, Card, CardHead, Empty, PageHead, Pill } from '../components/ui';

/**
 * Test, in the same three shapes the CLI has (§5).
 *
 * Full runs the structural checks and then reviews the Markdown those checks found. Structure is
 * that first half alone and needs no key. Content is the second half alone, for the loop where you
 * are editing the Markdown and already know the headers are fine.
 *
 * The content review renders in its own cards, well below the score and visually separate from it.
 * That separation is §5's rule and not a layout preference: the 0-100 number is a structural
 * measurement, and folding a model's opinion into it would make the number unreproducible.
 */

interface ModeOption {
  value: TestMode;
  label: string;
  note: string;
}

const MODES: ModeOption[] = [
  { value: 'full', label: 'Everything', note: 'The checks, then an AI review of every Markdown document they find.' },
  { value: 'structure', label: 'Structure only', note: 'The 0-100 score. No key, no model, no cost.' },
  { value: 'content', label: 'Content only', note: 'Skip the checks and just review the Markdown. Needs a key.' },
];

export function TestView({
  state,
  initial,
  onResult,
}: {
  state: State;
  /** The last run of this session, if there was one. Onboarding's closing score is one. */
  initial?: TestResponse;
  onResult: (result: TestResponse) => void;
}) {
  const [url, setUrl] = useState(state.config.site);
  const [mode, setMode] = useState<TestMode>('full');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<ApiProgress>();
  // Seeded rather than empty, so the tab opens on the number the user has already watched arrive
  // instead of on "No result yet" inviting them to run the test they just ran.
  const [result, setResult] = useState<TestResponse | undefined>(initial);

  async function run() {
    setBusy(true);
    setError(undefined);
    setProgress(undefined);
    try {
      const next = await api.test({ url, mode }, (event) => {
        setProgress(event);
        // The structural half is a finished answer on its own, and the content review after it is
        // one provider call per document. Showing the score the moment it exists is what the
        // terminal does, and it is the difference between a two second wait and a four minute one.
        if (event.phase === 'structure-done') setResult({ mode, ...event.structure });
      });
      setResult(next);
      onResult(next);
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : String(thrown));
      setResult(undefined);
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  }

  // Only `content` is blocked outright by a missing key. `full` degrades to the structural half and
  // says so afterwards, which is the common case and should not read as an error before it runs.
  const keyBlocked = mode === 'content' && !state.key.present;
  const keyPartial = mode === 'full' && !state.key.present;

  return (
    <>
      <PageHead title="Test">
        Score one live URL out of 100 against the 22 checks, and have a model read the Markdown your
        site serves. Nothing is written to disk.
      </PageHead>

      <Card className="card-pad stack">
        <div className="modes" role="group" aria-label="What to run">
          {MODES.map((option) => (
            <button
              key={option.value}
              type="button"
              className="mode"
              aria-pressed={mode === option.value}
              onClick={() => setMode(option.value)}
            >
              <strong>{option.label}</strong>
              <span>{option.note}</span>
            </button>
          ))}
        </div>

        <div className="row">
          <input
            className="grow"
            type="text"
            value={url}
            spellCheck={false}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !busy) void run();
            }}
            aria-label="URL to test"
            placeholder="http://localhost:3000/resume"
          />
          <Button primary busy={busy} disabled={!url.trim() || keyBlocked} onClick={() => void run()}>
            {busy ? 'Testing' : 'Run test'}
          </Button>
        </div>

        {keyBlocked ? (
          <p className="note">
            A content review needs an API key. Add one in Settings, or switch to Structure only.
          </p>
        ) : null}
        {keyPartial ? (
          <p className="note">
            No key configured, so this will run the structural checks and stop there. That is the
            whole score either way.
          </p>
        ) : null}
        {busy ? <RunProgress event={progress} idle="Starting" /> : null}
        {busy && mode !== 'structure' ? (
          <p className="note">
            Reading each Markdown document is a separate model call, so this takes a while.
          </p>
        ) : null}
      </Card>

      {error ? (
        <Banner tone="fail" title="The test could not run">
          {error}
        </Banner>
      ) : null}

      {result ? (
        <>
          {result.score ? (
            <Card>
              <ScorePanel score={result.score} url={result.url} framework={result.framework} history={result.history} />
            </Card>
          ) : null}
          {result.checks ? <CheckList checks={result.checks} score={result.score} /> : null}
          <ContentCard result={result} />
        </>
      ) : busy ? null : (
        <PastRuns url={url} />
      )}
    </>
  );
}

/**
 * Where this URL has been, on the screen that has no result on it yet.
 *
 * "No result yet, run a test" is true and useless: the project has almost certainly been tested
 * before, the scores are on disk, and a returning user asking "did my change help" should not have
 * to run something to find out where they started. Filtered to the URL in the box, because a trend
 * mixing two different sites is a line with no meaning.
 *
 * Local only. `.opengeo/history.json` sits beside the manifest and is never web-served, so this is
 * the only way to see it short of opening the file.
 */
function PastRuns({ url }: { url: string }) {
  const [entries, setEntries] = useState<HistoryEntry[]>();

  useEffect(() => {
    // Errors are swallowed: a project with no history at all is the normal first-run case, and it
    // arrives here as an empty list or a failed read depending on whether `.opengeo/` exists yet.
    void api
      .history()
      .then((history) => setEntries(history.entries))
      .catch(() => setEntries([]));
  }, []);

  const mine = (entries ?? []).filter((entry) => entry.score !== undefined && sameUrl(entry.url, url));
  if (entries === undefined || mine.length === 0) {
    return (
      <Card className="card-pad">
        <Empty title="No result yet">
          Run a test to see which of the 22 checks pass, which fail, and exactly why.
        </Empty>
      </Card>
    );
  }

  // Oldest first on disk and oldest first on screen, which is the only order in which the deltas
  // between the chips mean what they say. Capped at the last eight: the file keeps twenty, and a row
  // of twenty numbers is a table nobody asked for.
  const ordered = mine.slice(-8);
  const latest = ordered[ordered.length - 1]!;

  return (
    <Card>
      <CardHead title="Where this URL has been" sub={`${mine.length} recorded run${mine.length === 1 ? '' : 's'}, on this machine only`} />
      <div className="card-pad stack-sm">
        <div className="past-runs">
          {ordered.map((entry, index) => {
            const before = ordered[index - 1];
            const change = before?.score === undefined ? undefined : entry.score! - before.score;
            return (
              <div className="past-run" key={`${entry.at}-${index}`}>
                <b>{entry.score}</b>
                <span className="muted">{ago(entry.at)}</span>
                {change ? <span className={change > 0 ? 'delta delta-up' : 'delta delta-down'}>{change > 0 ? '+' : ''}{change}</span> : null}
              </div>
            );
          })}
        </div>
        <p className="note note-sm">
          Last run {ago(latest.at)} and scored {latest.score}. Run it again to see what has moved.
        </p>
      </div>
    </Card>
  );
}

/**
 * Whether two URL strings name the same page.
 *
 * The box holds whatever was typed and the history holds what the runner resolved, so
 * `http://localhost:3100` and `http://localhost:3100/` are one site recorded two ways. Compared as
 * parsed URLs rather than as strings, because a string comparison hid every past run behind a
 * trailing slash nobody types.
 */
function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a.trim() === b.trim();
  }
}

/**
 * The first line of a message written for a terminal, capitalised, without the block under it.
 *
 * `ERRORS.noApiKey` is hard-wrapped at 68 columns with indented shell lines beneath it. That is
 * right where it was written and collapses into one grey paragraph the moment HTML lays it out. The
 * first line is the reason, which is the only part of it a page with a Settings tab needs.
 */
function reasonOnly(message: string): string {
  const line = message.split('\n', 1)[0]!.trim();
  return line.charAt(0).toUpperCase() + line.slice(1);
}

function ContentCard({ result }: { result: TestResponse }) {
  if (result.contentError) {
    return (
      <Card>
        <CardHead title="Content review" sub="Separate from the score, always." />
        <div className="card-pad">
          <Banner tone="fail" title="The review did not run">
            {/* Line structure preserved. These messages are written for a terminal and some of them
                are several lines with an indented command in the middle, which HTML otherwise lays
                out as one unreadable grey paragraph. */}
            <span className="pre-wrap">{result.contentError}</span>
          </Banner>
        </div>
      </Card>
    );
  }

  if (result.contentSkipped) {
    return (
      <Card>
        <CardHead title="Content review" sub="Separate from the score, always." />
        <div className="card-pad">
          <Banner tone="info" title="Skipped">
            {/* The reason only. The rest of the canonical message is instructions for setting a key
                up by hand in a terminal, and this page has a Settings tab that does it with a form,
                so it points at that instead of reprinting a shell transcript. */}
            {reasonOnly(result.contentSkipped)} Add one in Settings and run this again. The
            structural score above is complete either way.
          </Banner>
        </div>
      </Card>
    );
  }

  const content = result.content;
  if (!content) return null;
  const rejected = result.discovery?.rejected ?? [];

  if (content.documents.length === 0) {
    return (
      <Card>
        <CardHead title="Content review" sub={`${content.provider} / ${content.model}`} />
        <div className="card-pad">
          <Empty title="No Markdown documents found">
            OpenGEO looked in llms.txt, the sitemap, and at the twin URL for this page. Run Generate
            to write them.
          </Empty>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHead
          title="Content review"
          sub={`${content.provider} / ${content.model}. How good the Markdown is, scored apart from the structural 0-100 above.`}
          right={content.score !== undefined ? <Pill tone={toneFor(content.score)}>{content.score} / 100</Pill> : undefined}
        />
        <div className="card-pad stack">
          <p className="muted" style={{ margin: 0 }}>
            {content.documents.length} document{content.documents.length === 1 ? '' : 's'} read
            {content.notReviewed > 0 ? `, ${content.notReviewed} left out to keep the run short` : ''}.
          </p>
          {content.areaScores.length ? <AreaBars areas={content.areaScores} /> : null}
          {rejected.length ? (
            <div>
              <div className="group-title">Looked like documents, were not</div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 20 }} className="muted">
                {rejected.map((entry) => (
                  <li key={entry.url}>
                    <span className="mono">{shortPath(entry.url)}</span> {entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Card>

      {content.recommendations.length ? (
        <Card>
          <CardHead
            title="What to change first"
            sub="One list for the whole site. The same edit needed on two pages appears once, with both."
          />
          <div className="card-pad stack-sm">
            {content.recommendations.map((recommendation, index) => (
              <Recommendation key={recommendation.action} recommendation={recommendation} index={index + 1} />
            ))}
          </div>
        </Card>
      ) : null}

      {[...content.documents]
        .sort((a, b) => (a.review?.score ?? 999) - (b.review?.score ?? 999))
        .map((doc) => (
          <DocumentCard key={doc.url} doc={doc} />
        ))}
    </>
  );
}

/**
 * Costliest area first, which is not the same as weakest.
 *
 * The last column is what the gap in that area takes off the 100, so a middling score in a heavy
 * area outranks a bad one in a light area. That is the ordering somebody deciding what to fix
 * actually needs, and it is why the number beside the bar is a loss rather than a rating.
 */
function AreaBars({ areas }: { areas: ContentReview['areaScores'] }) {
  return (
    <div className="areas">
      {areas.map((area) => (
        <div className="area" key={area.area}>
          <span className="area-label">
            {area.area}
            {area.weight !== undefined ? <span className="muted"> /{area.weight}</span> : null}
          </span>
          <span className="area-track">
            <span className={`area-fill tone-${toneFor(area.score)}`} style={{ width: `${area.score}%` }} />
          </span>
          <span className="area-value num">{area.lost > 0 ? `-${area.lost}` : area.score}</span>
        </div>
      ))}
    </div>
  );
}

/** One edit: what to change, where, and what the reader gains by it. */
function Recommendation({ recommendation, index }: { recommendation: QualityRecommendation; index?: number }) {
  return (
    <div className="rec">
      <span className={`rec-priority rec-${recommendation.priority}`}>{recommendation.priority}</span>
      <div>
        <div>
          {index !== undefined ? <span className="muted">{index}. </span> : null}
          {recommendation.action}
        </div>
        {recommendation.impact ? <div className="muted">{recommendation.impact}</div> : null}
        <div className="muted mono rec-where">
          {[recommendation.area, recommendation.where, ...(recommendation.documents ?? []).map(shortPath)]
            .filter(Boolean)
            .join('  ')}
        </div>
      </div>
    </div>
  );
}

function DocumentCard({ doc }: { doc: DocumentReview }) {
  const review = doc.review;
  return (
    <Card>
      <CardHead
        title={shortPath(doc.url)}
        sub={`${doc.words.toLocaleString()} words, found via ${doc.source}`}
        right={review?.score !== undefined ? <Pill tone={toneFor(review.score)}>{review.score} / 100</Pill> : undefined}
      />
      <div className="card-pad stack">
        {doc.error ? (
          <Banner tone="warn" title="Not reviewed">
            {doc.error}
          </Banner>
        ) : null}
        {review ? (
          <>
            <p style={{ margin: 0 }}>{review.summary}</p>
            {review.findings.length ? (
              <div className="stack-sm">
                {review.findings.map((finding) => (
                  <div key={finding.area}>
                    <strong>{finding.area}</strong>
                    {finding.score !== undefined ? <span className="muted"> {finding.score}/100</span> : null}
                    <span className="muted">. {finding.note}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {review.recommendations.length ? (
              <div className="stack-sm">
                <div className="group-title">What to change here</div>
                {review.recommendations.map((recommendation) => (
                  <Recommendation key={recommendation.action} recommendation={recommendation} />
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}

/** The same bands the terminal report colours by, so the two never disagree about what 74 means. */
function toneFor(score: number): 'ok' | 'warn' | 'fail' {
  if (score >= 75) return 'ok';
  if (score >= 50) return 'warn';
  return 'fail';
}

/** The path is what tells two twins apart. The origin is the same for all of them. */
function shortPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
