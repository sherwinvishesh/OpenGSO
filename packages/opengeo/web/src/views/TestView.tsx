import { useState } from 'react';
import { api, ApiError } from '../api';
import type { State, TestResponse } from '../types';
import { CheckList } from '../components/Checks';
import { ScorePanel } from '../components/Score';
import { Banner, Button, Card, CardHead, Empty, PageHead } from '../components/ui';

/**
 * Test: run the 22 checks against a live URL and show the score with every reason attached.
 *
 * The quality review renders in its own card, well below the score and visually separate from it.
 * That separation is §5's rule and not a layout preference: the 0-100 number is a
 * structural measurement, and folding a model's opinion into it would make the number unreproducible.
 */

export function TestView({ state, onResult }: { state: State; onResult: (result: TestResponse) => void }) {
  const [url, setUrl] = useState(state.config.site);
  const [quality, setQuality] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<TestResponse>();

  async function run() {
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.test({ url, quality });
      setResult(next);
      onResult(next);
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : String(thrown));
      setResult(undefined);
    } finally {
      setBusy(false);
    }
  }

  const keyMissing = quality && !state.key.present;

  return (
    <>
      <PageHead title="Test">
        Score one live URL out of 100 against the 22 checks. Nothing is written to disk, and the only
        network requests are to the URL you name here.
      </PageHead>

      <Card className="card-pad">
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
          <label className="checkbox">
            <input type="checkbox" checked={quality} onChange={(event) => setQuality(event.target.checked)} />
            Quality review
          </label>
          <Button primary busy={busy} disabled={!url.trim()} onClick={() => void run()}>
            {busy ? 'Testing' : 'Run test'}
          </Button>
        </div>
        {keyMissing ? (
          <p className="muted" style={{ marginBottom: 0, marginTop: 12, fontSize: 13 }}>
            The quality review needs an API key. Add one in Settings, or untick the box to run the
            structural checks on their own.
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
          <Card>
            <ScorePanel score={result.score} url={result.url} framework={result.framework} />
          </Card>
          <CheckList checks={result.checks} />
          <QualityCard result={result} />
        </>
      ) : busy ? null : (
        <Card className="card-pad">
          <Empty title="No result yet">
            Run a test to see which of the 22 checks pass, which fail, and exactly why.
          </Empty>
        </Card>
      )}
    </>
  );
}

function QualityCard({ result }: { result: TestResponse }) {
  if (!result.quality && !result.qualityError) return null;

  if (result.qualityError) {
    return (
      <Card>
        <CardHead title="Quality review" sub="Separate from the score, always." />
        <div className="card-pad">
          <Banner tone="info" title="The review did not run">
            {result.qualityError}
          </Banner>
        </div>
      </Card>
    );
  }

  const quality = result.quality!;
  return (
    <Card>
      <CardHead
        title="Quality review"
        sub={`${quality.provider} / ${quality.model}. Not part of the score above.`}
      />
      <div className="card-pad stack">
        <p style={{ margin: 0 }}>{quality.summary}</p>
        {quality.findings.length ? (
          <div className="stack-sm">
            {quality.findings.map((finding) => (
              <div key={finding.label}>
                <strong>{finding.label}. </strong>
                <span className="muted">{finding.detail}</span>
              </div>
            ))}
          </div>
        ) : null}
        {quality.suggestions.length ? (
          <div>
            <div className="group-title">Suggestions</div>
            <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
              {quality.suggestions.map((suggestion) => (
                <li key={suggestion}>{suggestion}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
