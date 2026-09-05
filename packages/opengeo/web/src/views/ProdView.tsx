import { useState } from 'react';
import { api, ApiError } from '../api';
import type { AiBot, ProdProbe, ProdResponse, State } from '../types';
import { Banner, Button, Card, CardHead, Empty, Field, PageHead, Pill } from '../components/ui';

/**
 * Prod: probe a running site and report the two levers separately (idea.md §7).
 *
 * The grouping here is the whole point. Lever 1 decides which agents receive markdown and can
 * never deny anyone anything; lever 2 is an opt-in robots.txt block list that prod does not even
 * have code for. Showing them in one merged list would quietly teach the reader that routing is a
 * form of blocking, which is the exact confusion the design avoids.
 */

const LEVERS = [
  {
    id: 'routing' as const,
    title: 'Lever 1 - markdown routing',
    sub: 'Which agents receive the twin. This never denies anyone anything: an unlisted bot sees the ordinary site.',
  },
  {
    id: 'negotiation' as const,
    title: 'Content negotiation',
    sub: 'Same URL, different representation, driven by the Accept header rather than by who is asking.',
  },
  {
    id: 'blocking' as const,
    title: 'Lever 2 - robots.txt blocking',
    sub: 'Opt-in, empty by default, and written by generate. Prod has no blocking code path at all.',
  },
];

export function ProdView({ state, bots }: { state: State; bots: AiBot[] }) {
  const [url, setUrl] = useState(state.config.site);
  const [bot, setBot] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ProdResponse>();

  async function run() {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api.prodTest({ url, bot: bot || undefined }));
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : String(thrown));
      setResult(undefined);
    } finally {
      setBusy(false);
    }
  }

  const routable = bots.filter((entry) => entry.uaPatterns.length > 0);

  return (
    <>
      <PageHead title="Prod">
        Probe a running site to see whether the middleware is installed and what each of the two bot
        levers is actually doing. This reads your deployment, it never changes it.
      </PageHead>

      <Card className="card-pad">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="grow">
            <Field label="Site URL">
              <input
                type="text"
                value={url}
                spellCheck={false}
                onChange={(event) => setUrl(event.target.value)}
                aria-label="Site URL to probe"
              />
            </Field>
          </div>
          <Field label="Impersonate">
            <select value={bot} onChange={(event) => setBot(event.target.value)}>
              <option value="">ClaudeBot (default)</option>
              {routable.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}
                </option>
              ))}
            </select>
          </Field>
          <Button primary busy={busy} disabled={!url.trim()} onClick={() => void run()}>
            {busy ? 'Probing' : 'Run probes'}
          </Button>
        </div>
      </Card>

      {error ? (
        <Banner tone="fail" title="The probes could not run">
          {error}
        </Banner>
      ) : null}

      {result ? <Report result={result} /> : busy ? null : (
        <Card className="card-pad">
          <Empty title="No probes run yet">
            Start your site, then run the probes to see the levers from the outside, exactly as an
            agent would.
          </Empty>
        </Card>
      )}
    </>
  );
}

function Report({ result }: { result: ProdResponse }) {
  return (
    <>
      {!result.installed ? (
        <Banner tone="fail" title="No response carried X-AEO-Version">
          Nothing at {result.target} answered like OpenGEO's middleware, so every probe below is
          describing a site without prod installed.
        </Banner>
      ) : null}

      {result.conflicts.length ? (
        <Banner tone="warn" title="The two levers contradict each other">
          {result.conflicts.join(' ')}
        </Banner>
      ) : null}

      <Card className="card-pad">
        <div className="row">
          <Pill tone="ok">{result.counts.pass} pass</Pill>
          <Pill tone="warn">{result.counts.warn} warn</Pill>
          <Pill tone="fail">{result.counts.fail} fail</Pill>
          <span className="muted">
            Impersonated {result.bot}. Twin URL <span className="mono">{result.twinUrl}</span>.
          </span>
        </div>
      </Card>

      {LEVERS.map((lever) => {
        const probes = result.probes.filter((probe) => probe.lever === lever.id);
        if (!probes.length) return null;
        return (
          <Card key={lever.id}>
            <CardHead title={lever.title} sub={lever.sub} />
            <div className="card-pad stack">
              {probes.map((probe) => (
                <ProbeRow key={probe.id} probe={probe} />
              ))}
            </div>
          </Card>
        );
      })}

      <Card>
        <CardHead
          title="robots.txt"
          sub={result.robots.found ? result.robots.url : `Nothing served at ${result.robots.url}`}
        />
        <div className="card-pad stack-sm">
          {result.robots.found ? (
            <>
              <div>
                <span className="group-title">Allowed</span>{' '}
                <span className="muted">{result.robots.allowed.join(', ') || 'nothing named explicitly'}</span>
              </div>
              <div>
                <span className="group-title">Blocked</span>{' '}
                <span className="muted">{result.robots.blocked.join(', ') || 'nobody'}</span>
              </div>
            </>
          ) : (
            <span className="muted">
              Without a robots.txt, most crawlers assume they may fetch everything. Run generate to
              write one, or hand-write it yourself.
            </span>
          )}
          {result.robots.notes.map((note) => (
            <div key={note} className="muted">
              {note}
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

function ProbeRow({ probe }: { probe: ProdProbe }) {
  const tone = probe.verdict === 'pass' ? 'ok' : probe.verdict === 'warn' ? 'warn' : 'fail';
  return (
    <div className="stack-sm">
      <div className="row">
        <Pill tone={tone}>{probe.verdict}</Pill>
        <strong>{probe.title}</strong>
        <span className="muted mono">HTTP {probe.status}</span>
      </div>
      <div className="muted">{probe.reason}</div>
      {probe.detail ? <div className="mono muted">{probe.detail}</div> : null}
      <details className="probe">
        <summary>What was sent, and what came back</summary>
        <pre className="pre" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
          {probe.curl}
          {'\n\n'}
          {Object.entries(probe.headers)
            .map(([name, value]) => `${name}: ${value}`)
            .join('\n') || '(no OpenGEO headers came back)'}
        </pre>
      </details>
    </div>
  );
}
