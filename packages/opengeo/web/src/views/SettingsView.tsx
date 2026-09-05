import { useState } from 'react';
import { api, ApiError } from '../api';
import type { OpenGeoConfig, State } from '../types';
import { Banner, Button, Card, CardHead, Field, PageHead, Pill } from '../components/ui';

/**
 * Settings: the config file and the API key, edited in place.
 *
 * The key section is written to be auditable rather than reassuring. It names the exact file the
 * key is written to, says which file the running process actually read it from, and states the one
 * network call it is ever used for. §11 is a promise about behaviour, and the only honest
 * way to present a promise like that is to show the reader where to go and check.
 */

export function SettingsView({ state, onSaved }: { state: State; onSaved: () => void }) {
  return (
    <>
      <PageHead title="Settings">
        Everything on this page is stored in your project, in files you can read. Nothing is sent
        anywhere.
      </PageHead>
      <ProjectCard state={state} onSaved={onSaved} />
      <KeyCard state={state} onSaved={onSaved} />
      <AboutCard state={state} />
    </>
  );
}

function ProjectCard({ state, onSaved }: { state: State; onSaved: () => void }) {
  const [site, setSite] = useState(state.config.site);
  const [maxPages, setMaxPages] = useState(String(state.config.crawl.maxPages));
  const [maxDepth, setMaxDepth] = useState(String(state.config.crawl.maxDepth));
  const [minWords, setMinWords] = useState(String(state.config.generate.minWords));
  const [tier, setTier] = useState(state.config.generate.tier);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(undefined);
    const patch: Partial<OpenGeoConfig> = {
      site: site.trim(),
      crawl: { ...state.config.crawl, maxPages: number(maxPages, state.config.crawl.maxPages), maxDepth: number(maxDepth, state.config.crawl.maxDepth) },
      generate: { tier, minWords: number(minWords, state.config.generate.minWords) },
    };
    try {
      await api.saveConfig(patch);
      setSaved(true);
      onSaved();
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : String(thrown));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHead
        title="Project"
        sub={state.configPath}
        right={
          <div className="row">
            {saved ? <span className="muted">Saved</span> : null}
            <Button primary busy={busy} onClick={() => void save()}>
              Save
            </Button>
          </div>
        }
      />
      <div className="card-pad stack">
        <Field label="Site URL" hint="The default target for test, generate and prod.">
          <input type="text" value={site} spellCheck={false} onChange={(event) => { setSaved(false); setSite(event.target.value); }} />
        </Field>
        <div className="row">
          <div className="grow">
            <Field label="Max pages" hint="A ceiling on the crawl, not a target.">
              <input type="number" min={1} value={maxPages} onChange={(event) => { setSaved(false); setMaxPages(event.target.value); }} />
            </Field>
          </div>
          <div className="grow">
            <Field label="Max depth" hint="Link hops from the starting URL.">
              <input type="number" min={0} value={maxDepth} onChange={(event) => { setSaved(false); setMaxDepth(event.target.value); }} />
            </Field>
          </div>
          <div className="grow">
            <Field label="Low-content warning below" hint="Words. Usually means a client-rendered page.">
              <input type="number" min={0} value={minWords} onChange={(event) => { setSaved(false); setMinWords(event.target.value); }} />
            </Field>
          </div>
        </div>
        <Field label="Default generate tier" hint="free is algorithmic and needs no key. ai is BYOK and falls back to free whenever a fact would be lost.">
          <select value={tier} onChange={(event) => { setSaved(false); setTier(event.target.value as 'free' | 'ai'); }}>
            <option value="free">free</option>
            <option value="ai">ai</option>
          </select>
        </Field>
        <div className="muted" style={{ fontSize: 13 }}>
          Generated files go to <span className="mono">{state.publicDir}</span>. Bookkeeping that must
          never be web-served goes to <span className="mono">{state.internalDir}</span>.
        </div>
        {error ? <Banner tone="fail">{error}</Banner> : null}
      </div>
    </Card>
  );
}

function KeyCard({ state, onSaved }: { state: State; onSaved: () => void }) {
  const [provider, setProvider] = useState(state.key.provider ?? state.config.ai.provider);
  const [model, setModel] = useState(state.key.model ?? state.config.ai.model);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ envPath: string; gitignoreAdded: boolean; gitignorePath: string }>();

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.saveKey({ provider, apiKey, model });
      setDone(result);
      setApiKey('');
      onSaved();
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : String(thrown));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHead
        title="AI key"
        sub="Optional. Everything except the AI generate tier and the quality review works without one."
        right={state.key.present ? <Pill tone="ok">key found</Pill> : <Pill tone="mute">no key</Pill>}
      />
      <div className="card-pad stack">
        <Banner tone="info" title="Where your key lives, and where it goes">
          It is written to <span className="mono">{state.key.path}</span> and nowhere else. It is never
          written to {state.configPath.split('/').pop()}, never included in an API response, and the
          only request it is ever attached to is the direct call to the provider you pick below.
          OpenGEO has no telemetry, no analytics and no cloud sync, so there is no second place for it
          to go.
          {state.key.present && state.key.source === 'process-env'
            ? ' The key this process is currently using came from the environment rather than that file.'
            : ''}
        </Banner>

        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Provider">
            <select
              value={provider}
              onChange={(event) => {
                const next = event.target.value as typeof provider;
                setProvider(next);
                setModel(state.defaultModels[next] ?? '');
              }}
            >
              {state.providers.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </Field>
          <div className="grow">
            <Field label="Model">
              <input type="text" value={model} spellCheck={false} onChange={(event) => setModel(event.target.value)} />
            </Field>
          </div>
        </div>

        <Field
          label={state.key.present ? 'Replace the key' : 'API key'}
          hint=".env is added to .gitignore before the key is written, every time."
        >
          <input
            type="password"
            value={apiKey}
            spellCheck={false}
            autoComplete="off"
            placeholder={state.key.present ? 'leave blank to keep the current key' : 'sk-...'}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>

        <div className="row">
          <Button primary busy={busy} disabled={!apiKey.trim()} onClick={() => void save()}>
            Save key
          </Button>
          {state.ci ? <span className="muted">CI is set here, so AI features will refuse to run anyway.</span> : null}
        </div>

        {error ? <Banner tone="fail">{error}</Banner> : null}
        {done ? (
          <Banner tone="ok" title="Saved">
            Written to <span className="mono">{done.envPath}</span>.{' '}
            {done.gitignoreAdded
              ? `Added .env to ${done.gitignorePath} first.`
              : `.env was already ignored by ${done.gitignorePath}.`}
          </Banner>
        ) : null}
      </div>
    </Card>
  );
}

function AboutCard({ state }: { state: State }) {
  return (
    <Card>
      <CardHead title="About" sub={`${state.packageName} ${state.version}`} />
      <div className="card-pad stack-sm">
        <Row label="Project root" value={state.root} />
        <Row label="Config" value={state.configExists ? state.configPath : `${state.configPath} (defaults, not written yet)`} />
        <Row label="Generated output" value={state.publicDir} />
        <Row label="Bookkeeping" value={state.internalDir} />
        <Row label="Key file" value={state.key.path} />
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row">
      <span className="group-title" style={{ minWidth: 140 }}>
        {label}
      </span>
      <span className="mono muted">{value}</span>
    </div>
  );
}

function number(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
