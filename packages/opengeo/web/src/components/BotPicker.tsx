import { useState } from 'react';
import type { AiBot, BotKind, CustomBot } from '../types';
import { Button, Field, Pill } from './ui';

/**
 * The crawler-picking half of the dashboard, shared by onboarding and Bot settings.
 *
 * It is the same four answers the terminal offers, for the same reason: three of them cover almost
 * every project, and the fourth exists for the two cases they cannot. A site that wants a specific
 * handful of agents picks them by hand, and a site whose crawler is not in OpenGEO's list at all
 * adds it. A crawler added here is written to `bots.custom` in the config, which is the list prod
 * loads at boot, so it is routable as soon as the site restarts.
 *
 * The mode is derived from the selection rather than stored. That way a list edited by hand, or by
 * `opengeo settings`, still shows the right button highlighted next time the page loads.
 */

export type RoutingMode = 'all' | 'assistants' | 'none' | 'custom';

export const KIND_NOTE: Record<BotKind, string> = {
  assistant: 'Fetches a page because a person asked about it, right now.',
  search: 'Indexes pages to answer search queries later.',
  training: 'Collects pages as training data.',
};

export function routableOnly(bots: AiBot[]): AiBot[] {
  return bots.filter((bot) => bot.uaPatterns.length > 0);
}

export function assistantNames(routable: AiBot[]): string[] {
  return routable.filter((bot) => bot.kind !== 'training').map((bot) => bot.name);
}

export function routingModeOf(routing: string[], routable: AiBot[]): RoutingMode {
  if (routing.length === 0) return 'none';
  if (sameNames(routing, routable.map((bot) => bot.name))) return 'all';
  if (sameNames(routing, assistantNames(routable))) return 'assistants';
  return 'custom';
}

/** What picking a mode does to the list. `custom` keeps whatever is already selected. */
export function routingForMode(mode: RoutingMode, routable: AiBot[], current: string[]): string[] {
  if (mode === 'all') return routable.map((bot) => bot.name);
  if (mode === 'assistants') return assistantNames(routable);
  if (mode === 'none') return [];
  return current;
}

export function sameNames(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
}

export function RoutingModes({
  mode,
  routable,
  onPick,
}: {
  mode: RoutingMode;
  routable: AiBot[];
  onPick: (mode: RoutingMode) => void;
}) {
  const options: Array<{ value: RoutingMode; label: string; sub: string }> = [
    { value: 'all', label: 'Everyone', sub: `all ${routable.length} agents` },
    { value: 'assistants', label: 'Assistants and search', sub: `${assistantNames(routable).length} agents` },
    { value: 'none', label: 'Nobody', sub: 'Accept header only' },
    { value: 'custom', label: 'Let me pick', sub: 'one by one' },
  ];
  return (
    <div className="modes" role="group" aria-label="Markdown routing">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="mode"
          aria-pressed={mode === option.value}
          onClick={() => onPick(option.value)}
        >
          <strong>{option.label}</strong>
          <span>{option.sub}</span>
        </button>
      ))}
    </div>
  );
}

export function CrawlerChecklist({
  bots,
  selected,
  onToggle,
  onRemove,
}: {
  bots: AiBot[];
  selected: string[];
  onToggle: (name: string) => void;
  /** Only ever offered for a crawler this project added. The shipped list is not editable. */
  onRemove?: (name: string) => void;
}) {
  return (
    <div className="crawler-grid">
      {bots.map((bot) => (
        <div className="crawler" key={bot.name}>
          <label className="checkbox">
            <input type="checkbox" checked={selected.includes(bot.name)} onChange={() => onToggle(bot.name)} />
            <span>
              {bot.name} <Pill tone="mute">{bot.vendor}</Pill>
              {bot.custom ? <Pill tone="ok">yours</Pill> : null}
            </span>
          </label>
          {onRemove && bot.custom ? (
            <button type="button" className="link-btn" onClick={() => onRemove(bot.name)}>
              remove
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

const BLANK = { name: '', vendor: '', uaPatterns: '', robotsToken: '', kind: 'assistant' as BotKind };

/**
 * Add a crawler OpenGEO has never heard of.
 *
 * Only the name is asked for. Everything else is guessed from it, because a crawler almost always
 * puts its own name in its User-Agent, and a form that demanded four fields for the common case
 * would be the reason nobody used this.
 */
export function AddCrawler({
  existing,
  onAdd,
}: {
  existing: AiBot[];
  onAdd: (bot: CustomBot) => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [error, setError] = useState<string>();

  if (!open) {
    return (
      <button type="button" className="add-crawler" onClick={() => setOpen(true)}>
        + Add a crawler OpenGEO has never heard of
      </button>
    );
  }

  const set = (key: keyof typeof BLANK) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  function submit() {
    const name = form.name.trim();
    if (!name) return setError('A crawler needs a name.');
    if (existing.some((bot) => bot.name.toLowerCase() === name.toLowerCase())) {
      return setError(`${name} is already on the list.`);
    }
    const patterns = form.uaPatterns
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    onAdd({
      name,
      vendor: form.vendor.trim() || 'Custom',
      uaPatterns: patterns.length > 0 ? patterns : [name.toLowerCase()],
      robotsToken: form.robotsToken.trim() || name,
      kind: form.kind,
    });
    setForm(BLANK);
    setError(undefined);
    setOpen(false);
  }

  return (
    <div className="crawler-form">
      <div className="row">
        <div className="grow">
          <Field label="Name" hint="What you want to call it. Used in robots.txt and matched in the User-Agent.">
            <input type="text" value={form.name} spellCheck={false} autoFocus onChange={set('name')} />
          </Field>
        </div>
        <Field label="What it does">
          <select value={form.kind} onChange={set('kind')}>
            <option value="assistant">assistant</option>
            <option value="search">search</option>
            <option value="training">training</option>
          </select>
        </Field>
      </div>
      <div className="row">
        <div className="grow">
          <Field label="Who runs it" hint="Optional.">
            <input type="text" value={form.vendor} placeholder="Custom" spellCheck={false} onChange={set('vendor')} />
          </Field>
        </div>
        <div className="grow">
          <Field label="User-Agent contains" hint={`Optional. Defaults to "${form.name.trim().toLowerCase() || 'the name'}".`}>
            <input type="text" value={form.uaPatterns} spellCheck={false} onChange={set('uaPatterns')} />
          </Field>
        </div>
        <div className="grow">
          <Field label="robots.txt token" hint="Optional. Defaults to the name.">
            <input type="text" value={form.robotsToken} spellCheck={false} onChange={set('robotsToken')} />
          </Field>
        </div>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      <div className="row">
        <Button primary onClick={submit}>
          Add crawler
        </Button>
        <Button
          onClick={() => {
            setOpen(false);
            setForm(BLANK);
            setError(undefined);
          }}
        >
          Cancel
        </Button>
        <span className="muted" style={{ fontSize: 13 }}>
          Saved into opengeo.config.json. Your site picks it up on the next restart.
        </span>
      </div>
    </div>
  );
}
