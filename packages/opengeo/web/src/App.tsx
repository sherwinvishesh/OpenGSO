import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { AiBot, CheckResult, State, TestResponse } from './types';
import { StalenessBanner } from './components/Staleness';
import { Banner, Button, Card } from './components/ui';
import { BotsView } from './views/BotsView';
import { GenerateView } from './views/GenerateView';
import { Onboarding } from './views/Onboarding';
import { ProdView } from './views/ProdView';
import { SettingsView } from './views/SettingsView';
import { TestView } from './views/TestView';

/**
 * The shell: nav, theme, and the one piece of state every view needs.
 *
 * There is no router and no store. The app has five screens and a single source of server state, so
 * a `useState` and a reload function is the whole architecture. Anything more would be scaffolding
 * for a scale this deliberately does not have.
 */

type Tab = 'test' | 'generate' | 'prod' | 'bots' | 'settings';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'test', label: 'Test' },
  { id: 'generate', label: 'Generate' },
  { id: 'prod', label: 'Prod' },
  { id: 'bots', label: 'Bot settings' },
  { id: 'settings', label: 'Settings' },
];

const THEME_KEY = 'opengeo.theme';

export function App() {
  const [tab, setTab] = useState<Tab>('test');
  const [state, setState] = useState<State>();
  // Undefined until the request lands, not `[]`. Onboarding decides which of the four routing
  // answers is already true by comparing the saved list against the crawler list, and an empty
  // crawler list makes "everyone" look like a hand-picked selection.
  const [bots, setBots] = useState<AiBot[]>();
  const [error, setError] = useState<string>();
  const [lastTest, setLastTest] = useState<TestResponse>();
  const [theme, setTheme] = useState<'light' | 'dark'>(readTheme);
  const [onboarded, setOnboarded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const next = await api.state();
      setState(next);
      setError(undefined);
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : String(thrown));
    }
  }, []);

  useEffect(() => {
    void reload();
    api.bots().then((response) => setBots(response.bots)).catch(() => setBots([]));
  }, [reload]);

  // Five screens, five keys. The dashboard is a tool somebody comes back to a dozen times while
  // fixing one page, and reaching for the mouse to change tab every time is the kind of small tax
  // that makes a tool feel slow long before anything actually is.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= TABS.length) return;
      event.preventDefault();
      setTab(TABS[index].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // A browser with storage disabled still gets the theme, it just forgets it on reload.
    }
  }, [theme]);

  if (error && !state) {
    return (
      <div className="onboarding">
        <Card className="card-pad onboarding-card">
          <Banner tone="fail" title="Cannot reach the local server">
            {error} The dashboard is served by `opengeo start`, so if that process has stopped, start
            it again and reload this page.
          </Banner>
        </Card>
      </div>
    );
  }

  if (!state || !bots) return <Skeleton />;

  if (!state.configExists && !onboarded) {
    return (
      <Onboarding
        state={state}
        bots={bots}
        onDone={(firstTest) => {
          setOnboarded(true);
          // Onboarding ran the structural test on its way out, so the Test tab opens on that number
          // rather than on an empty panel inviting the user to run the thing they just watched run.
          if (firstTest) setLastTest(firstTest);
          void reload();
        }}
      />
    );
  }

  const drift = lastTest?.checks?.find((check: CheckResult) => check.id === 'B14');

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <strong>OpenGEO</strong>
          <span>{state.version}</span>
        </div>

        <nav className="nav">
          {TABS.map((entry, index) => (
            <button key={entry.id} aria-current={tab === entry.id} onClick={() => setTab(entry.id)}>
              <span>{entry.label}</span>
              <span className="nav-right">
                <kbd aria-hidden="true">{index + 1}</kbd>
                <NavDot id={entry.id} state={state} lastTest={lastTest} />
              </span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div>
            <div className="group-title">Project</div>
            <div className="project-path">{state.root}</div>
          </div>
          <div>
            {state.key.present ? `Key found in ${state.key.source === 'env-file' ? '.env' : 'the environment'}.` : 'No AI key. The free tier needs none.'}
          </div>
          <Button small onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </Button>
        </div>
      </aside>

      <main className="main">
        <div className="main-inner">
          {error ? (
            <Banner tone="warn" title="The last refresh failed">
              {error}
            </Banner>
          ) : null}

          <StalenessBanner
            state={state}
            drift={drift}
            onGenerate={() => setTab('generate')}
          />

          {tab === 'test' ? (
            <TestView
              state={state}
              initial={lastTest}
              onResult={(result) => {
                setLastTest(result);
                void reload();
              }}
            />
          ) : null}
          {tab === 'generate' ? <GenerateView state={state} onDone={() => void reload()} /> : null}
          {tab === 'prod' ? <ProdView state={state} bots={bots} /> : null}
          {tab === 'bots' ? <BotsView state={state} bots={bots} onSaved={() => void reload()} /> : null}
          {tab === 'settings' ? <SettingsView state={state} onSaved={() => void reload()} /> : null}
        </div>
      </main>
    </div>
  );
}

/**
 * The shell, greyed, for the moment before `/api/state` and `/api/bots` land.
 *
 * It is the real layout rather than a centred word, so the sidebar and the first card are already
 * in their final positions and nothing jumps when the data arrives.
 */
function Skeleton() {
  return (
    <div className="shell" aria-hidden="true">
      <aside className="sidebar">
        <div className="brand">
          <strong>OpenGEO</strong>
        </div>
        <div className="nav">
          {TABS.map((entry) => (
            <div key={entry.id} className="skeleton skeleton-nav" />
          ))}
        </div>
      </aside>
      <main className="main">
        <div className="main-inner">
          <div className="skeleton skeleton-line" style={{ width: 180 }} />
          <div className="skeleton skeleton-card" />
          <div className="skeleton skeleton-card" />
        </div>
      </main>
    </div>
  );
}

/** Typing into a field should never be read as a shortcut, whatever the field happens to be. */
function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable;
}

/** A status dot, only where there is a real status to report. Never a decoration. */
function NavDot({ id, state, lastTest }: { id: Tab; state: State; lastTest?: TestResponse }) {
  let color: string | undefined;
  // A content-only run has no structural score, so it has nothing to report here. Colouring the
  // dot from the content score would put an opinion where a measurement is expected.
  const value = lastTest?.score?.value;
  if (id === 'test' && value !== undefined) {
    color = value >= 90 ? 'var(--ok)' : value >= 60 ? 'var(--warn)' : 'var(--danger)';
  }
  if (id === 'generate' && !state.manifest) color = 'var(--warn)';
  if (!color) return null;
  return <span className="nav-dot" style={{ background: color }} />;
}

function readTheme(): 'light' | 'dark' {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Ignored: a stored preference is a convenience, not a requirement.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
