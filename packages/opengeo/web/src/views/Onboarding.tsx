import { useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type { AiBot, CustomBot, State } from '../types';
import type { RoutingMode } from '../components/BotPicker';
import { AddCrawler, CrawlerChecklist, RoutingModes, routableOnly, routingForMode, routingModeOf } from '../components/BotPicker';
import type { ProviderDraft } from '../components/ProviderFields';
import { ProviderFields, draftForProvider, providerInfoOf } from '../components/ProviderFields';
import { Banner, Button, Card, CardHead, Field } from '../components/ui';

/**
 * First run: project, then key, then bots (§8).
 *
 * Three steps, two of them skippable, because the target is a first real result in a minute or two.
 * The key step comes second rather than first for the same reason setup asks in that order: it is
 * optional, and putting an optional secret in front of the thing that actually works would make the
 * tool feel like it needs one.
 */

const STEPS = ['Project', 'AI key', 'Bots'] as const;

export function Onboarding({ state, bots, onDone }: { state: State; bots: AiBot[]; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [site, setSite] = useState(state.config.site);
  const [ai, setAi] = useState<ProviderDraft>(() => ({
    ...draftForProvider(state.providerCatalog, state.config.ai.provider),
    model: state.config.ai.model,
  }));
  const [publicDir, setPublicDir] = useState(state.config.publicDir);
  const [added, setAdded] = useState<CustomBot[]>([]);
  const [routing, setRouting] = useState<string[]>(state.config.bots.markdownRouting);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Crawlers added during onboarding join the list immediately, so they can be ticked in the same
  // pass rather than after a save-and-reload.
  const routable = useMemo(() => routableOnly([...bots, ...added.map(asBot)]), [bots, added]);
  // Held rather than derived. Deriving it would make "let me pick" a no-op whenever the current
  // selection happens to match one of the three canned answers, which is exactly when a first-run
  // user clicks it: the default is everyone.
  const [mode, setMode] = useState<RoutingMode>(() => routingModeOf(routing, routableOnly(bots)));

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
      onDone();
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : String(thrown));
      setBusy(false);
    }
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
            <div key={name} className={`step-dot ${index <= step ? 'done' : ''}`} />
          ))}
        </div>

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
                <Field
                  label="Web root"
                  hint={`Where generated files land. Default: ${state.config.publicDir}`}
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
