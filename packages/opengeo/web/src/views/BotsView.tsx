import { useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type { RoutingMode } from '../components/BotPicker';
import { AddCrawler, KIND_NOTE, routableOnly, routingForMode, routingModeOf, sameNames } from '../components/BotPicker';
import { Banner, Button, Card, CardHead, PageHead, Pill } from '../components/ui';
import type { AiBot, CustomBot, State } from '../types';

/**
 * Bot settings: the two levers from §7, on one page but never in one list.
 *
 * The UI enforces the distinction the design depends on. Routing is a format decision and cannot
 * deny anybody anything, so its column has no warning attached. Blocking is a real denial, is
 * opt-in, and only takes effect the next time generate writes robots.txt, so it says so on screen
 * rather than in the docs.
 *
 * The table is the by-hand answer, so the presets sit above it rather than replacing it: most
 * people want one of the three canned lists and should not have to click twenty-six checkboxes to
 * express it. Underneath, a project can add a crawler OpenGEO has never heard of, which is the one
 * thing a shipped list can never cover on its own.
 */

export function BotsView({ state, bots, onSaved }: { state: State; bots: AiBot[]; onSaved: () => void }) {
  const [routing, setRouting] = useState<string[]>(state.config.bots.markdownRouting);
  const [blocked, setBlocked] = useState<string[]>(state.config.bots.blocked);
  const [custom, setCustom] = useState<CustomBot[]>(state.config.bots.custom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  // Crawlers added here appear in the table straight away, before any save, so they can be routed
  // and blocked in the same pass.
  const shown = useMemo(() => {
    const known = new Set(bots.map((bot) => bot.name.toLowerCase()));
    return [...bots, ...custom.filter((bot) => !known.has(bot.name.toLowerCase())).map(asBot)];
  }, [bots, custom]);
  const routable = useMemo(() => routableOnly(shown), [shown]);
  const mode = routingModeOf(routing, routable);

  const dirty =
    !sameNames(routing, state.config.bots.markdownRouting) ||
    !sameNames(blocked, state.config.bots.blocked) ||
    !sameNames(custom.map((bot) => bot.name), state.config.bots.custom.map((bot) => bot.name));

  function toggle(list: string[], set: (next: string[]) => void, name: string) {
    setSaved(false);
    set(list.includes(name) ? list.filter((entry) => entry !== name) : [...list, name]);
  }

  function addCrawler(bot: CustomBot) {
    setSaved(false);
    setCustom((current) => [...current, bot]);
    setRouting((current) => [...current, bot.name]);
  }

  function removeCrawler(name: string) {
    setSaved(false);
    setCustom((current) => current.filter((bot) => bot.name !== name));
    setRouting((current) => current.filter((entry) => entry !== name));
    setBlocked((current) => current.filter((entry) => entry !== name));
  }

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      await api.saveConfig({ bots: { markdownRouting: routing, blocked, custom } });
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
        <div className="card-pad" style={{ borderBottom: '1px solid var(--border)' }}>
          <RoutingPresets
            mode={mode}
            routable={routable}
            onPick={(next) => {
              setSaved(false);
              setRouting(routingForMode(next, routable, routing));
            }}
          />
        </div>
        <div className="bot-row" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="group-title">Bot</div>
          <div className="group-title">Markdown</div>
          <div className="group-title">Blocked</div>
        </div>
        {shown.map((bot) => (
          <div className="bot-row" key={bot.name}>
            <div>
              <div className="bot-name">
                {bot.name} <Pill tone="mute">{bot.kind}</Pill>{' '}
                {bot.custom ? <Pill tone="ok">yours</Pill> : null}{' '}
                {bot.uaPatterns.length === 0 ? <Pill tone="mute">robots.txt only</Pill> : null}
              </div>
              <div className="bot-meta">
                {bot.vendor}. {bot.notes ?? KIND_NOTE[bot.kind]}
                {bot.custom ? (
                  <>
                    {' '}
                    Matches any User-Agent containing {bot.uaPatterns.join(' or ')}.{' '}
                    <button type="button" className="link-btn" onClick={() => removeCrawler(bot.name)}>
                      remove
                    </button>
                  </>
                ) : null}
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
        <div className="card-pad">
          <AddCrawler existing={shown} onAdd={addCrawler} />
        </div>
      </Card>

      <Card className="card-pad">
        <p className="muted" style={{ margin: 0 }}>
          A bot with no User-Agent pattern cannot be routed, because there is no crawler to recognise
          at request time. It can still be named in robots.txt, which is how vendors like Google
          expose an AI-training opt-out separate from their search crawler.
        </p>
        <p className="muted" style={{ margin: '10px 0 0' }}>
          A crawler you add is stored in <span className="mono">bots.custom</span> in{' '}
          <span className="mono">opengeo.config.json</span> and behaves exactly like a built-in one:
          both levers apply to it. Your site loads that list at boot, so restart it after saving.
        </p>
      </Card>
    </>
  );
}

/**
 * The three canned answers plus the by-hand one. `custom` is a label here rather than a button,
 * because the table underneath is already the by-hand answer: there is nothing extra to reveal.
 */
function RoutingPresets({
  mode,
  routable,
  onPick,
}: {
  mode: RoutingMode;
  routable: AiBot[];
  onPick: (mode: RoutingMode) => void;
}) {
  const assistants = routable.filter((bot) => bot.kind !== 'training').length;
  return (
    <div className="row">
      <span className="group-title" style={{ margin: 0 }}>
        Markdown routing
      </span>
      <Button small onClick={() => onPick('all')}>
        Everyone ({routable.length})
      </Button>
      <Button small onClick={() => onPick('assistants')}>
        Assistants and search ({assistants})
      </Button>
      <Button small onClick={() => onPick('none')}>
        Nobody
      </Button>
      <div className="grow" />
      <span className="note note-sm">
        {mode === 'custom' ? 'A list you picked by hand.' : 'Or tick them one by one below.'}
      </span>
    </div>
  );
}

/** A crawler from the config, shaped like the resolved list so the table can render it. */
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
