import type { ProviderInfo } from '../types';
import { Field } from './ui';

/**
 * The provider half of the key form, shared by Settings and onboarding so the two can never drift.
 *
 * Everything here is driven by the catalogue the server sends, not by a list compiled into the
 * bundle. Adding a provider to core makes it appear in this dropdown without a dashboard change,
 * which is the whole reason the catalogue is in the state response.
 *
 * Three shapes come out of that: a hosted provider needs a key and nothing else, a keyless one
 * (a model server on this machine) needs no key at all, and a user-defined one needs the endpoint
 * and the wire format because OpenGEO has no way to guess them.
 */

export interface ProviderDraft {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  api: string;
}

export function providerInfoOf(catalog: ProviderInfo[], id: string): ProviderInfo | undefined {
  return catalog.find((entry) => entry.id === id);
}

/** Switching provider resets the fields that belonged to the old one. Keeping them would send a
 *  Claude model id to Groq, and the error that produces explains nothing. */
export function draftForProvider(catalog: ProviderInfo[], id: string, apiKey = ''): ProviderDraft {
  const info = providerInfoOf(catalog, id);
  return {
    provider: id,
    model: info?.userDefined ? '' : (info?.defaultModel ?? ''),
    apiKey,
    baseUrl: info?.userDefined ? '' : (info?.baseUrl ?? ''),
    api: info?.api ?? 'openai',
  };
}

/** Whether the form has enough to write. A keyless provider is complete without a secret. */
export function draftReady(draft: ProviderDraft, info: ProviderInfo | undefined, keyOptional: boolean): boolean {
  if (!draft.model.trim()) return false;
  if (info?.userDefined && !draft.baseUrl.trim()) return false;
  if (info?.keyless) return true;
  return keyOptional || draft.apiKey.trim().length > 0;
}

export function ProviderFields({
  catalog,
  draft,
  onChange,
  keyLabel,
  keyHint,
  keyPlaceholder,
}: {
  catalog: ProviderInfo[];
  draft: ProviderDraft;
  onChange: (next: ProviderDraft) => void;
  keyLabel: string;
  keyHint?: string;
  keyPlaceholder?: string;
}) {
  const info = providerInfoOf(catalog, draft.provider);
  const custom = Boolean(info?.userDefined);

  return (
    <>
      <div className="row row-end">
        <Field label="Provider">
          <select
            value={draft.provider}
            onChange={(event) => onChange(draftForProvider(catalog, event.target.value, draft.apiKey))}
          >
            {catalog.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="grow">
          <Field
            label="Model"
            hint={custom ? 'The model id your endpoint expects.' : info ? `Default: ${info.defaultModel}` : undefined}
          >
            <input
              type="text"
              value={draft.model}
              spellCheck={false}
              onChange={(event) => onChange({ ...draft, model: event.target.value })}
            />
          </Field>
        </div>
      </div>

      {custom ? (
        <div className="row row-end">
          <div className="grow">
            <Field label="Base URL" hint="Everything up to the endpoint path, with no trailing slash.">
              <input
                type="text"
                value={draft.baseUrl}
                spellCheck={false}
                placeholder="https://gateway.example.com/v1"
                onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })}
              />
            </Field>
          </div>
          <Field label="API shape" hint="Which request format it speaks.">
            <select value={draft.api} onChange={(event) => onChange({ ...draft, api: event.target.value })}>
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic</option>
              <option value="gemini">Gemini</option>
            </select>
          </Field>
        </div>
      ) : null}

      {info?.keyless ? (
        <p className="note">
          {info.label} runs on this machine at <span className="mono">{info.baseUrl}</span>. There is no
          key to enter and nothing leaves the box.
        </p>
      ) : (
        <Field
          label={keyLabel}
          hint={
            <>
              {keyHint}
              {info?.keysUrl ? (
                <>
                  {keyHint ? ' ' : ''}
                  Get one at{' '}
                  <a href={info.keysUrl} target="_blank" rel="noreferrer noopener">
                    {info.keysUrl}
                  </a>
                  .
                </>
              ) : null}
            </>
          }
        >
          <input
            type="password"
            value={draft.apiKey}
            spellCheck={false}
            autoComplete="off"
            placeholder={keyPlaceholder}
            onChange={(event) => onChange({ ...draft, apiKey: event.target.value })}
          />
        </Field>
      )}
    </>
  );
}
