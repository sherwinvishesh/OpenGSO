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
  const [bots, setBots] = useState<AiBot[]>([]);
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

  if (!state) return <div className="onboarding muted">Loading project...</div>;

  if (!state.configExists && !onboarded) {
    return (
      <Onboarding
        state={state}
        bots={bots}
        onDone={() => {
          setOnboarded(true);
          void reload();
        }}
      />
    );
  }

  const drift = lastTest?.checks.find((check: CheckResult) => check.id === 'B14');

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <strong>OpenGEO</strong>
          <span>{state.version}</span>
        </div>

        <nav className="nav">
          {TABS.map((entry) => (
            <button key={entry.id} aria-current={tab === entry.id} onClick={() => setTab(entry.id)}>
              <span>{entry.label}</span>
              <NavDot id={entry.id} state={state} lastTest={lastTest} />
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

/** A status dot, only where there is a real status to report. Never a decoration. */
function NavDot({ id, state, lastTest }: { id: Tab; state: State; lastTest?: TestResponse }) {
  let color: string | undefined;
  if (id === 'test' && lastTest) {
    color = lastTest.score.value >= 90 ? 'var(--ok)' : lastTest.score.value >= 60 ? 'var(--warn)' : 'var(--danger)';
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
