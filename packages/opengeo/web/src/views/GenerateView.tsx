import { useState } from 'react';
import { api, ApiError } from '../api';
import type { GeneratePage, GenerateResponse, SiteFile, State } from '../types';
import { Banner, Button, Card, CardHead, Empty, Field, PageHead, Pill } from '../components/ui';

/**
 * Generate: crawl the site once and write the markdown twins plus robots.txt, llms.txt and
 * sitemap.xml (§6, one crawl, three outputs).
 *
 * The preview matters more than it looks. Everything else in this app describes the generated
 * files; this is the only place that shows the bytes an agent actually receives, read straight back
 * off disk rather than re-rendered from the response.
 */

/** `/` -> `md/index.md`, `/resume` -> `md/resume.md`. Mirrors core's routeToMdRelPath. */
function mdRelPath(route: string): string {
  const normalized = route.length > 1 && route.endsWith('/') ? route.slice(0, -1) : route;
  return `md/${normalized === '/' ? 'index' : normalized.replace(/^\//, '')}.md`;
}

export function GenerateView({ state, onDone }: { state: State; onDone: () => void }) {
  const [url, setUrl] = useState(state.config.site);
  const [tier, setTier] = useState<'free' | 'ai'>(state.config.generate.tier);
  const [single, setSingle] = useState(false);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [needsKey, setNeedsKey] = useState(false);
  const [result, setResult] = useState<GenerateResponse>();

  async function run() {
    setBusy(true);
    setError(undefined);
    setNeedsKey(false);
    try {
      setResult(await api.generate({ url, tier, single, force }));
      onDone();
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : String(thrown));
      if (thrown instanceof ApiError && thrown.extra.needsKey) setNeedsKey(true);
      setResult(undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead title="Generate">
        Crawl the site from this URL and write a markdown twin for every page it reaches, plus
        robots.txt, llms.txt and sitemap.xml. Files land in {state.publicDir}.
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
                aria-label="Site URL to generate from"
              />
            </Field>
          </div>
          <Field label="Tier">
            <select value={tier} onChange={(event) => setTier(event.target.value as 'free' | 'ai')}>
              <option value="free">free (algorithmic, no key)</option>
              <option value="ai">ai (BYOK, fidelity-checked)</option>
            </select>
          </Field>
          <Button primary busy={busy} disabled={!url.trim()} onClick={() => void run()}>
            {busy ? 'Generating' : 'Generate'}
          </Button>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <label className="checkbox">
            <input type="checkbox" checked={single} onChange={(event) => setSingle(event.target.checked)} />
            This page only, do not crawl
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
            Rewrite unchanged pages and overwrite existing site files
          </label>
        </div>
        {tier === 'ai' && !state.key.present ? (
          <p className="muted" style={{ margin: '12px 0 0', fontSize: 13 }}>
            The AI tier needs a key. Add one in Settings first. The free tier needs nothing and is
            what produces the fallback whenever the AI output loses a fact.
          </p>
        ) : null}
        {state.ci ? (
          <p className="muted" style={{ margin: '12px 0 0', fontSize: 13 }}>
            CI is set in this environment, so the AI tier will refuse to run. That is deliberate:
            generation is a local-machine step, never a build step.
          </p>
        ) : null}
      </Card>

      {error ? (
        <Banner tone="fail" title="Generate did not finish">
          {error}
          {needsKey ? ' Add a key in Settings, or switch to the free tier.' : ''}
        </Banner>
      ) : null}

      {result ? <Results result={result} /> : busy ? null : (
        <Card className="card-pad">
          <Empty title="Nothing generated in this session">
            {state.manifest
              ? `The last run wrote ${state.manifest.pages.length} page${state.manifest.pages.length === 1 ? '' : 's'}. Run generate again to refresh them.`
              : 'No markdown twins exist for this project yet.'}
          </Empty>
        </Card>
      )}
    </>
  );
}

function Results({ result }: { result: GenerateResponse }) {
  const written = result.pages.filter((page) => page.status === 'written').length;
  const cached = result.pages.filter((page) => page.status === 'cached').length;
  const failed = result.pages.filter((page) => page.status === 'failed').length;

  return (
    <>
      {result.warnings.length ? (
        <Banner tone="warn" title={`${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}`}>
          {result.warnings.join(' ')}
        </Banner>
      ) : null}

      <Card>
        <CardHead
          title="Pages"
          sub={`${written} written, ${cached} unchanged, ${failed} failed in ${(result.durationMs / 1000).toFixed(1)}s`}
        />
        <table className="table">
          <thead>
            <tr>
              <th>Route</th>
              <th>Status</th>
              <th className="num">Words</th>
              <th className="num">Tokens</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {result.pages.map((page) => (
              <PageRow key={page.route} page={page} />
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <CardHead title="Site files" sub="Written from the same crawl, never overwritten without asking." />
        <table className="table">
          <thead>
            <tr>
              <th>File</th>
              <th>Status</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody>
            {result.files.map((file) => (
              <FileRow key={file.name} file={file} />
            ))}
          </tbody>
        </table>
      </Card>

      <Preview pages={result.pages} />
    </>
  );
}

function PageRow({ page }: { page: GeneratePage }) {
  const tone = page.status === 'failed' ? 'fail' : page.status === 'written' ? 'ok' : 'mute';
  const notes = [page.reason, ...page.warnings].filter(Boolean).join(' ');
  return (
    <tr>
      <td className="mono">{page.route}</td>
      <td>
        <Pill tone={tone}>{page.status}</Pill>
      </td>
      <td className="num">{page.wordCount || ''}</td>
      <td className="num">{page.tokens || ''}</td>
      <td className="muted">{notes}</td>
    </tr>
  );
}

function FileRow({ file }: { file: SiteFile }) {
  const tone = file.status === 'failed' ? 'fail' : file.status === 'proposed' ? 'warn' : file.status === 'written' ? 'ok' : 'mute';
  return (
    <tr>
      <td className="mono">{file.name}</td>
      <td>
        <Pill tone={tone}>{file.status}</Pill>
      </td>
      <td className="mono muted">
        {file.path}
        {file.message ? <div>{file.message}</div> : null}
      </td>
    </tr>
  );
}

function Preview({ pages }: { pages: GeneratePage[] }) {
  const readable = pages.filter((page) => page.status !== 'failed');
  const [route, setRoute] = useState(readable[0]?.route ?? '');
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!readable.length) return null;

  async function load(next: string) {
    setRoute(next);
    setBusy(true);
    setError(undefined);
    try {
      const file = await api.readFile(mdRelPath(next));
      setContent(file.content);
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : String(thrown));
      setContent(undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHead
        title="What an agent receives"
        sub="Read back off disk, frontmatter and all."
        right={
          <div className="row">
            <select value={route} onChange={(event) => void load(event.target.value)} aria-label="Route to preview">
              {readable.map((page) => (
                <option key={page.route} value={page.route}>
                  {page.route}
                </option>
              ))}
            </select>
            <Button small busy={busy} onClick={() => void load(route)}>
              Show
            </Button>
          </div>
        }
      />
      <div className="card-pad">
        {error ? <Banner tone="warn">{error}</Banner> : null}
        {content ? <pre className="pre" style={{ whiteSpace: 'pre-wrap' }}>{content}</pre> : null}
        {!content && !error ? <span className="muted">Pick a route and press Show.</span> : null}
      </div>
    </Card>
  );
}
