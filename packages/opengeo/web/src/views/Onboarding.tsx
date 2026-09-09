import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { AiBot, CheckResult, CustomBot, SitePreview, State, TestResponse } from '../types';
import type { RoutingMode } from '../components/BotPicker';
import { AddCrawler, CrawlerChecklist, RoutingModes, routableOnly, routingForMode, routingModeOf } from '../components/BotPicker';
import type { ProviderDraft } from '../components/ProviderFields';
import { ProviderFields, draftForProvider, providerInfoOf } from '../components/ProviderFields';
import { ScorePanel } from '../components/Score';
import { Banner, Button, Card, CardHead, Field, Pill } from '../components/ui';

/**
 * First run: project, then key, then bots (§8).
 *
 * Three steps, two of them skippable, because the target is a first real result in a minute or two.
 * The key step comes second rather than first for the same reason setup asks in that order: it is
 * optional, and putting an optional secret in front of the thing that actually works would make the
 * tool feel like it needs one.
 *
 * The same three upgrades the terminal flow got, over the same endpoints, because the two doors onto
 * setup should not disagree about what OpenGEO can work out for itself. The URL is probed while it
 * is being typed, the web root arrives already detected with the reason attached, and Finish ends on
 * the site's actual score rather than on a redirect to an empty dashboard.
 */

const STEPS = ['Project', 'AI key', 'Bots'] as const;

export function Onboarding({
  state,
  bots,
  onDone,
}: {
  state: State;
  bots: AiBot[];
  /** The closing test, so the dashboard opens on the number the user just watched arrive. */
  onDone: (firstTest?: TestResponse) => void;
}) {
  const [step, setStep] = useState(0);
  const [site, setSite] = useState(state.config.site);
  const [ai, setAi] = useState<ProviderDraft>(() => ({
    ...draftForProvider(state.providerCatalog, state.config.ai.provider),
    model: state.config.ai.model,
  }));
  // The detector may fill in a box nobody has typed into, and may not overrule a saved answer. On
  // this screen there is no saved answer by definition, so the guess wins whenever it found one.
  const [publicDir, setPublicDir] = useState(state.webRoot.found ? state.webRoot.dir : state.config.publicDir);
  const [added, setAdded] = useState<CustomBot[]>([]);
  const [routing, setRouting] = useState<string[]>(state.config.bots.markdownRouting);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { preview, pending: probing } = useSitePreview(site);
  // Set once the config is saved and the closing test has run. Onboarding stays on screen for it:
  // the number is the reason the three questions were worth answering. `saved` rather than
  // `result !== undefined`, so a site that could not be reached still ends on the closing screen
  // instead of dropping back onto a form whose answers have already been written.
  const [saved, setSaved] = useState(false);
  const [result, setResult] = useState<TestResponse>();
  const [scoring, setScoring] = useState(false);

  // Crawlers added during onboarding join the list immediately, so they can be ticked in the same
  // pass rather than after a save-and-reload.
  const routable = useMemo(() => routableOnly([...bots, ...added.map(asBot)]), [bots, added]);
  // Held rather than derived. Deriving it would make "let me pick" a no-op whenever the current
  // selection happens to match one of the three canned answers, which is exactly when a first-run
  // user clicks it: the default is everyone.
  const [mode, setMode] = useState<RoutingMode>(() => routingModeOf(routing, routableOnly(bots)));

  // Ranked by points recoverable rather than by check order, because the first line of a first
  // report is the only one everybody reads and it should be the one worth most.
  const next = useMemo<CheckResult[]>(
    () =>
      (result?.checks ?? [])
        .filter((check) => check.status === 'fail' || check.status === 'partial')
        .sort((a, b) => b.weight - b.earned - (a.weight - a.earned))
        .slice(0, 3),
    [result],
  );

  async function finish() {
    setBusy(true);
    setError(undefined);
    try {
      const info = providerInfoOf(state.providerCatalog, ai.provider);
      // A keyless provider is still worth saving: it is the whole configuration for a local model
      // server, and skipping it because no secret was typed would silently drop the choice.
      const keyless = Boolean(info?.keyless);
      if (ai.apiKey.trim() || (keyless && ai.model.trim())) {
        await api.saveKey({
          provider: ai.provider,
          apiKey: ai.apiKey.trim(),
          model: ai.model,
          baseUrl: ai.baseUrl || undefined,
          api: info?.userDefined ? ai.api : undefined,
          auth: keyless ? 'none' : undefined,
        });
      }
      await api.saveConfig({
        site: site.trim(),
        publicDir: publicDir.trim() || state.config.publicDir,
        bots: {
          markdownRouting: routing,
          blocked: state.config.bots.blocked,
          custom: [...state.config.bots.custom, ...added],
        },
      });
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : String(thrown));
      setBusy(false);
      return;
    }

    // Saved. From here nothing can fail in a way that should undo the setup, so the score runs on
    // its own and a failure to reach the site is reported as a finding rather than as an error.
    setBusy(false);
    setSaved(true);
    setScoring(true);
    try {
      setResult(await api.test({ url: site.trim(), mode: 'structure' }));
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : String(thrown));
    }
    setScoring(false);
  }

  function toggle(name: string) {
    setRouting((current) => (current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name]));
  }

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div>
          <h1 style={{ margin: '0 0 4px', fontSize: 24, letterSpacing: '-0.02em' }}>Set up OpenGEO</h1>
          <p className="muted" style={{ margin: 0 }}>
            Three questions, then a first result. Everything is written into{' '}
            <span className="mono">{state.root}</span>.
          </p>
        </div>

        <div className="steps" aria-hidden="true">
          {STEPS.map((name, index) => (
            <div key={name} className={`step-dot ${saved || index <= step ? 'done' : ''}`} />
          ))}
        </div>

        {saved ? (
          <>
            <Card>
              <CardHead
                title="Where you stand"
                sub={scoring ? 'Running the structural test' : result?.score ? `${result.score.earned} of ${result.score.possible} applicable points` : undefined}
              />
              <div className="card-pad stack">
                <p className="muted" style={{ margin: 0 }}>
                  Saved. This is <span className="mono">{site.trim()}</span> against the structural
                  checks, run just now. Nothing was uploaded.
                </p>
                {scoring ? <Working /> : null}
                {result?.score ? (
                  <>
                    <ScorePanel score={result.score} url={result.url} framework={result.framework} />
                    {next.length > 0 ? (
                      <div>
                        <div className="group-title">Do this next (most points first)</div>
                        {next.map((check) => (
                          <div className="check" key={check.id}>
                            <div className="check-id">{check.id}</div>
                            <div>
                              <div className="check-title">{check.title}</div>
                              <div className="check-reason">{check.fix ?? check.reason}</div>
                            </div>
                            <div className="check-points">+{check.weight - check.earned}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <Banner tone="ok" title="Nothing to fix">
                        Every applicable check passed on the first run.
                      </Banner>
                    )}
                  </>
                ) : null}
                {error ? (
                  <Banner tone="warn" title="The score did not run">
                    {error} The settings are saved, and Test in the dashboard will try again.
                  </Banner>
                ) : null}
              </div>
            </Card>

            <div className="row">
              <div className="grow" />
              <Button primary disabled={scoring} onClick={() => onDone(result)}>
                Open the dashboard
              </Button>
            </div>
          </>
        ) : (
        <>
        <Card>
          <CardHead title={STEPS[step]} sub={`Step ${step + 1} of ${STEPS.length}`} />
          <div className="card-pad stack">
            {step === 0 ? (
              <>
                <Field label="Site URL" hint="Where your site runs. A local dev server is the normal answer.">
                  <input
                    type="text"
                    value={site}
                    spellCheck={false}
                    autoFocus
                    onChange={(event) => setSite(event.target.value)}
                  />
                </Field>
                <SitePreviewNote preview={preview} pending={probing} />
                <Field
                  label="Web root"
                  hint={
                    state.webRoot.found
                      ? `Where generated files land. ${state.webRoot.why}.`
                      : `Where generated files land. Default: ${state.config.publicDir}`
                  }
                >
                  <input
                    type="text"
                    value={publicDir}
                    spellCheck={false}
                    placeholder={state.config.publicDir}
                    onChange={(event) => setPublicDir(event.target.value)}
                  />
                </Field>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  OpenGEO reads this site over HTTP, exactly like an agent would. It never imports your
                  code and never needs to know which framework you use.
                </p>
              </>
            ) : null}

            {step === 1 ? (
              <>
                <p className="muted" style={{ margin: 0 }}>
                  Optional. Everything except the AI generate tier and the content review works
                  without a key, and you can add one later in Settings.
                </p>
                <ProviderFields
                  catalog={state.providerCatalog}
                  draft={ai}
                  onChange={setAi}
                  keyLabel="API key"
                  keyHint="Leave blank to skip."
                />
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  Not on the list? Pick <strong>Your own endpoint</strong> and give it a base URL.
                  Anything speaking the OpenAI, Anthropic or Gemini request format works.
                </p>
                <Banner tone="info" title="Where it goes">
                  Into <span className="mono">{state.key.path}</span>, after <span className="mono">.env</span>{' '}
                  is added to .gitignore. The only request it is ever attached to is the direct call to
                  the provider above.
                </Banner>
              </>
            ) : null}

            {step === 2 ? (
              <>
                <p className="muted" style={{ margin: 0 }}>
                  Which agents receive the markdown twin instead of HTML. This is a format decision, not
                  an access one: anyone unticked, and anyone not on this list at all, sees the ordinary
                  site. Blocking is a separate, opt-in setting under Bot settings.
                </p>
                <RoutingModes
                  mode={mode}
                  routable={routable}
                  onPick={(next) => {
                    setMode(next);
                    setRouting(routingForMode(next, routable, routing));
                  }}
                />
                {mode === 'custom' ? (
                  <>
                    <CrawlerChecklist
                      bots={routable}
                      selected={routing}
                      onToggle={toggle}
                      onRemove={(name) => {
                        setAdded((current) => current.filter((bot) => bot.name !== name));
                        setRouting((current) => current.filter((entry) => entry !== name));
                      }}
                    />
                    <AddCrawler
                      existing={routable}
                      onAdd={(bot) => {
                        setAdded((current) => [...current, bot]);
                        setRouting((current) => [...current, bot.name]);
                      }}
                    />
                  </>
                ) : (
                  <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                    {routing.length} of {routable.length} agents. Pick "Let me pick" to choose them by
                    name, or to add a crawler OpenGEO has never heard of.
                  </p>
                )}
              </>
            ) : null}

            {error ? <Banner tone="fail">{error}</Banner> : null}
          </div>
        </Card>

        <div className="row">
          <Button disabled={step === 0 || busy} onClick={() => setStep((current) => current - 1)}>
            Back
          </Button>
          <div className="grow" />
          {step < STEPS.length - 1 ? (
            <Button primary disabled={step === 0 && !site.trim()} onClick={() => setStep((current) => current + 1)}>
              {step === 1 && !ai.apiKey.trim() ? 'Skip' : 'Next'}
            </Button>
          ) : (
            <Button primary busy={busy} onClick={() => void finish()}>
              Finish
            </Button>
          )}
        </div>
        </>
        )}
      </div>
    </div>
  );
}

/** A just-added crawler, shaped like the resolved list so the checklist can render it. */
function asBot(bot: CustomBot): AiBot {
  return {
    name: bot.name,
    vendor: bot.vendor ?? 'Custom',
    uaPatterns: bot.uaPatterns ?? [bot.name.toLowerCase()],
    robotsToken: bot.robotsToken ?? bot.name,
    kind: bot.kind ?? 'assistant',
    notes: bot.notes,
    custom: true,
  };
}

/** The one place onboarding waits on the network for longer than a keystroke. */
function Working() {
  return (
    <div className="row" style={{ gap: 8 }}>
      <span className="spinner" aria-hidden="true" />
      <span className="muted">Fetching the site and running the structural checks...</span>
    </div>
  );
}

/**
 * The probe under the URL field, saying the same things the terminal says.
 *
 * Never an error banner, whatever it finds. Nothing here blocks setup: the URL is saved either way,
 * and the reason to show this at all is that "we cannot reach that" is worth knowing while the field
 * still has focus rather than after the first generate. A URL half-typed is the normal state of this
 * component, so it renders nothing until there is an answer about a whole one.
 */
function SitePreviewNote({ preview, pending }: { preview?: SitePreview; pending: boolean }) {
  if (pending && !preview) {
    return (
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        Checking that URL...
      </p>
    );
  }
  if (!preview) return null;

  if (preview.error) {
    return (
      <Note>
        <Pill tone="warn">no answer</Pill> Could not reach it: {preview.error}. Saved either way, and
        nothing else in setup depends on it.
      </Note>
    );
  }
  if (!preview.ok) {
    return (
      <Note>
        <Pill tone="warn">{preview.status}</Pill> That URL answered {preview.status}. Worth a second
        look, though the rest of setup does not depend on it.
      </Note>
    );
  }

  return (
    <Note>
      <div>
        <Pill tone="ok">reachable</Pill> {preview.status} in {preview.ttfbMs}ms
        {preview.framework ? `, ${preview.framework}` : ''}
      </div>
      {preview.clientRendered ? (
        <div>
          The raw HTML is an empty mount element, so the content only exists once JavaScript has run.
          Agents mostly do not run it, and neither does generate. Server-rendering is the fix.
        </div>
      ) : null}
      {preview.twin?.served ? (
        <div>
          A markdown twin is already being served at <span className="mono">{preview.twin.url}</span>,
          by opengeo-prod.
        </div>
      ) : preview.twin?.ok ? (
        <div>
          Something already answers at <span className="mono">{preview.twin.url}</span>, without
          OpenGEO's headers.
        </div>
      ) : preview.twin ? (
        <div>
          No twin at <span className="mono">{preview.twin.url}</span> yet. That is what generate and
          prod are for.
        </div>
      ) : null}
    </Note>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="stack-sm muted" style={{ marginTop: -8, fontSize: 12.5 }}>
      {children}
    </div>
  );
}

/**
 * The URL probed while it is being typed, without a request per keystroke.
 *
 * Debounced, and then sequence-guarded rather than aborted: a slow reply that lands after a newer
 * request went out is dropped instead of being allowed to overwrite it, which is the one failure
 * mode a field-driven fetch really has. Errors are swallowed on purpose. This is a convenience on
 * top of a field that works fine without it, and a red box about a URL somebody is halfway through
 * typing would be worse than showing nothing at all.
 */
function useSitePreview(url: string): { preview?: SitePreview; pending: boolean } {
  const [preview, setPreview] = useState<SitePreview>();
  const [pending, setPending] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    const target = url.trim();
    // Anything that is not yet a whole absolute URL is somebody mid-keystroke, not a site to probe.
    if (!/^https?:\/\/[^\s/]+/.test(target)) {
      latest.current += 1;
      setPreview(undefined);
      setPending(false);
      return;
    }

    const ticket = (latest.current += 1);
    setPending(true);
    const timer = setTimeout(() => {
      void api
        .preview(target)
        .then((response) => {
          if (ticket !== latest.current) return;
          setPreview(response.preview);
          setPending(false);
        })
        .catch(() => {
          if (ticket !== latest.current) return;
          setPreview(undefined);
          setPending(false);
        });
    }, 450);
    return () => clearTimeout(timer);
  }, [url]);

  return { preview, pending };
}
