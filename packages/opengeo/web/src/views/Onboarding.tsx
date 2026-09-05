import { useState } from 'react';
import { api, ApiError } from '../api';
import type { AiBot, State } from '../types';
import { Banner, Button, Card, CardHead, Field, Pill } from '../components/ui';

/**
 * First run: project, then key, then bots (idea.md §8).
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
  const [provider, setProvider] = useState(state.config.ai.provider);
  const [model, setModel] = useState(state.config.ai.model);
  const [apiKey, setApiKey] = useState('');
  const routable = bots.filter((bot) => bot.uaPatterns.length > 0);
  const [routing, setRouting] = useState<string[]>(state.config.bots.markdownRouting);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function finish() {
    setBusy(true);
    setError(undefined);
    try {
      if (apiKey.trim()) await api.saveKey({ provider, apiKey: apiKey.trim(), model });
      await api.saveConfig({ site: site.trim(), bots: { markdownRouting: routing, blocked: state.config.bots.blocked } });
      onDone();
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : String(thrown));
      setBusy(false);
    }
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
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  OpenGEO reads this site over HTTP, exactly like an agent would. It never imports your
                  code and never needs to know which framework you use.
                </p>
              </>
            ) : null}

            {step === 1 ? (
              <>
                <p className="muted" style={{ margin: 0 }}>
                  Optional. Everything except the AI generate tier and the quality review works without
                  a key, and you can add one later in Settings.
                </p>
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
                <Field label="API key" hint="Leave blank to skip.">
                  <input
                    type="password"
                    value={apiKey}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                </Field>
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
                <div className="stack-sm">
                  {routable.map((bot) => (
                    <label className="checkbox" key={bot.name}>
                      <input
                        type="checkbox"
                        checked={routing.includes(bot.name)}
                        onChange={() =>
                          setRouting((current) =>
                            current.includes(bot.name) ? current.filter((entry) => entry !== bot.name) : [...current, bot.name],
                          )
                        }
                      />
                      {bot.name} <Pill tone="mute">{bot.vendor}</Pill>
                    </label>
                  ))}
                </div>
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
              {step === 1 && !apiKey.trim() ? 'Skip' : 'Next'}
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
