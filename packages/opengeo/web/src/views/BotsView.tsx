import { useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type { AiBot, State } from '../types';
import { Banner, Button, Card, CardHead, PageHead, Pill } from '../components/ui';

/**
 * Bot settings: the two levers from idea.md §7, on one page but never in one list.
 *
 * The UI enforces the distinction the design depends on. Routing is a format decision and cannot
 * deny anybody anything, so its column has no warning attached. Blocking is a real denial, is
 * opt-in, and only takes effect the next time generate writes robots.txt, so it says so on screen
 * rather than in the docs.
 */

const KIND_NOTE: Record<string, string> = {
  assistant: 'Fetches a page because a person asked about it, right now.',
  search: 'Indexes pages to answer search queries later.',
  training: 'Collects pages as training data.',
};

export function BotsView({ state, bots, onSaved }: { state: State; bots: AiBot[]; onSaved: () => void }) {
  const [routing, setRouting] = useState<string[]>(state.config.bots.markdownRouting);
  const [blocked, setBlocked] = useState<string[]>(state.config.bots.blocked);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const dirty = useMemo(
    () => !same(routing, state.config.bots.markdownRouting) || !same(blocked, state.config.bots.blocked),
    [routing, blocked, state.config.bots.markdownRouting, state.config.bots.blocked],
  );

  function toggle(list: string[], set: (next: string[]) => void, name: string) {
    setSaved(false);
    set(list.includes(name) ? list.filter((entry) => entry !== name) : [...list, name]);
  }

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      await api.saveConfig({ bots: { markdownRouting: routing, blocked } });
      setSaved(true);
      onSaved();
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : String(thrown));
    } finally {
      setBusy(false);
    }
  }

  const conflicts = routing.filter((name) => blocked.includes(name));

  return (
    <>
      <PageHead title="Bot settings">
        Two independent levers. The first decides who gets markdown instead of HTML. The second is a
        block list, and it is the only one of the two that denies anybody anything.
      </PageHead>

      {error ? (
        <Banner tone="fail" title="Could not save">
          {error}
        </Banner>
      ) : null}

      {conflicts.length ? (
        <Banner tone="warn" title="These bots are set to receive markdown and to be blocked">
          {conflicts.join(', ')}. A blocked bot that obeys robots.txt will never arrive to be routed,
          so one of the two settings is doing nothing. Decide which one you meant.
        </Banner>
      ) : null}

      {blocked.length ? (
        <Banner tone="info" title="Blocking only takes effect after the next generate">
          Prod contains no blocking code. The block list is expressed entirely through the robots.txt
          that generate writes, so run Generate for a change here to reach your site. Note also that
          robots.txt is a request, not a fence: it stops well-behaved crawlers and nothing else.
        </Banner>
      ) : null}

      <Card>
        <CardHead
          title="AI bots"
          sub={`${routing.length} receive markdown, ${blocked.length} blocked. Unlisted and unknown bots always see the ordinary site.`}
          right={
            <div className="row">
              {saved && !dirty ? <span className="muted">Saved</span> : null}
              <Button primary busy={busy} disabled={!dirty} onClick={() => void save()}>
                Save
              </Button>
            </div>
          }
        />
        <div className="bot-row" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="group-title">Bot</div>
          <div className="group-title">Markdown</div>
          <div className="group-title">Blocked</div>
        </div>
        {bots.map((bot) => (
          <div className="bot-row" key={bot.name}>
            <div>
              <div className="bot-name">
                {bot.name}{' '}
                <Pill tone="mute">{bot.kind}</Pill>{' '}
                {bot.uaPatterns.length === 0 ? <Pill tone="mute">robots.txt only</Pill> : null}
              </div>
              <div className="bot-meta">
                {bot.vendor}. {bot.notes ?? KIND_NOTE[bot.kind]}
              </div>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={routing.includes(bot.name)}
                disabled={bot.uaPatterns.length === 0}
                onChange={() => toggle(routing, setRouting, bot.name)}
              />
              {bot.uaPatterns.length === 0 ? 'n/a' : 'markdown'}
            </label>
            <label className="toggle">
              <input type="checkbox" checked={blocked.includes(bot.name)} onChange={() => toggle(blocked, setBlocked, bot.name)} />
              block
            </label>
          </div>
        ))}
      </Card>

      <Card className="card-pad">
        <p className="muted" style={{ margin: 0 }}>
          A bot with no User-Agent pattern cannot be routed, because there is no crawler to recognise
          at request time. It can still be named in robots.txt, which is how vendors like Google
          expose an AI-training opt-out separate from their search crawler.
        </p>
      </Card>
    </>
  );
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
}
