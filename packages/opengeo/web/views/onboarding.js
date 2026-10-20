import { api, ApiError } from '../api.js';
import {
  createAddCrawler,
  createCrawlerChecklist,
  createRoutingModes,
  routableOnly,
  routingForMode,
  routingModeOf,
  shownBots,
  toggled,
} from '../components/bot-picker.js';
import { twinFaultIds } from '../components/checks.js';
import { createProgress } from '../components/progress.js';
import { createProviderFields, customEndpointLabel, draftForProvider, draftReady, keyKept, providerInfoOf } from '../components/provider-fields.js';
import { scorePanel } from '../components/score.js';
import { isAbort, startRun } from '../runs.js';
import { banner, button, card, cardHead, el, field, fill, pill, setBusy, setLabel, setText } from '../ui.js';

/**
 * @import { CheckResult, CustomBotInput, ProviderInfo, SitePreview, StateResponse, TestResponse } from '../../../core/src/shared/api-types.js'
 * @import { Ctx, View } from '../context.js'
 * @import { ProviderDraft } from '../components/provider-fields.js'
 * @import { RoutingMode } from '../components/bot-picker.js'
 */

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
 *
 * Nothing here calls `ctx.reload()`. The config exists the moment Finish saves it, and a reload would
 * take the shell's gate past onboarding before the closing score had been shown.
 */

const STEPS = ['Project', 'AI key', 'Bots'];

const PREVIEW_DELAY_MS = 450;

// -- pure helpers --------------------------------------------------------------------------------

/**
 * Anything that is not yet a whole absolute URL is somebody mid-keystroke, not a site to probe.
 *
 * @param {string} value
 */
export function probeable(value) {
  return /^https?:\/\/[^\s/]+/.test(value.trim());
}

/**
 * Ranked by points recoverable rather than by check order, because the first line of a first
 * report is the only one everybody reads and it should be the one worth most. The scored fixes come
 * first; the suggestions fill whatever room is left, heaviest first, the same order the terminal
 * prints them in.
 *
 * @param {CheckResult[]} checks
 * @returns {CheckResult[]}
 */
export function nextFixes(checks) {
  /** @param {CheckResult} check */
  const open = (check) => check.status === 'fail' || check.status === 'partial';
  const fixes = checks.filter((check) => check.scored && open(check)).sort((a, b) => b.weight - b.earned - (a.weight - a.earned));
  const faults = twinFaultIds(checks);
  const ideas = checks
    .filter((check) => !check.scored && open(check))
    .sort((a, b) => Number(faults.has(b.id)) - Number(faults.has(a.id)) || b.weight - a.weight);
  return [...fixes, ...ideas].slice(0, 3);
}

/**
 * Whether Finish writes the key step at all.
 *
 * A typed key always goes, so the server can say what is wrong with it. A keyless provider is still
 * worth saving: it is the whole configuration for a local model server, and skipping it because no
 * secret was typed would silently drop the choice. A blank field over a key already saved for this
 * provider goes only once the step was edited, and then keeps that key, exactly as Settings does.
 * An untouched step is a skip, and a skip writes nothing.
 *
 * @param {ProviderDraft} draft
 * @param {ProviderInfo | undefined} info
 * @param {StateResponse['key']} key
 * @param {boolean} edited
 */
export function keyStepSaves(draft, info, key, edited) {
  if (draft.apiKey.trim()) return true;
  if (info?.keyless) return true;
  return edited && keyKept(key, draft.provider);
}

/**
 * Whether the key step can be left. Only a step that will write is held to Settings' rule; a skip
 * is always allowed.
 *
 * @param {ProviderDraft} draft
 * @param {ProviderInfo | undefined} info
 * @param {StateResponse['key']} key
 * @param {boolean} edited
 */
export function keyStepReady(draft, info, key, edited) {
  if (!keyStepSaves(draft, info, key, edited)) return true;
  return draftReady(draft, info, { keyPresent: keyKept(key, draft.provider) });
}

/** @param {unknown} thrown */
const messageOf = (thrown) => (thrown instanceof ApiError ? thrown.message : String(thrown));

// -- the view ------------------------------------------------------------------------------------

/**
 * @param {Ctx} ctx
 * @param {(firstTest?: TestResponse) => void} onDone The closing test, so the dashboard opens on the
 *   number the user just watched arrive.
 * @returns {View}
 */
export function createOnboarding(ctx, onDone) {
  const initial = ctx.state();

  let step = 0;
  let busy = false;
  /** @type {string | undefined} */
  let error;
  // Set once the config is saved. Onboarding stays on screen for the closing test: the number is
  // the reason the three questions were worth answering. `saved` rather than `result !== undefined`,
  // so a site that could not be reached still ends on the closing screen instead of dropping back
  // onto a form whose answers have already been written.
  let saved = false;
  let scoring = false;
  /** @type {TestResponse | undefined} */
  let result;
  let finishedSite = '';
  let keyEdited = false;
  let autofocused = false;

  /** @type {string[]} */
  let routing = [...initial.config.bots.markdownRouting];
  // The project's crawlers, edited here and written on Finish. Ones added during onboarding join the
  // list immediately, so they can be ticked in the same pass rather than after a save-and-reload.
  /** @type {CustomBotInput[]} */
  let custom = [...initial.config.bots.custom];
  // Held rather than derived. Deriving it would make "let me pick" a no-op whenever the current
  // selection happens to match one of the three canned answers, which is exactly when a first-run
  // user clicks it: the default is everyone.
  /** @type {RoutingMode} */
  let mode = routingModeOf(routing, routableOnly(ctx.bots()));

  // -- header and step dots ----------------------------------------------------------------------

  const rootPath = el('span', { className: 'mono' });
  const dots = STEPS.map(() => el('div', { className: 'step-dot' }));

  // -- step 0: project ---------------------------------------------------------------------------

  // The detector may fill in a box nobody has typed into, and may not overrule a saved answer. On
  // this screen there is no saved answer by definition, so the guess wins whenever it found one.
  const siteInput = el('input', { attrs: { type: 'text', spellcheck: 'false', autofocus: true } });
  siteInput.value = initial.config.site;
  let siteEdited = false;
  const publicDirInput = el('input', { attrs: { type: 'text', spellcheck: 'false' } });
  publicDirInput.value = webRootGuess(initial);
  let publicDirEdited = false;
  const webRootHint = el('span');
  const previewSlot = el('div', { className: 'contents' });

  siteInput.addEventListener('input', () => {
    siteEdited = true;
    probe();
    drawNav();
  });
  publicDirInput.addEventListener('input', () => {
    publicDirEdited = true;
  });

  const projectStep = el(
    'div',
    { className: 'contents' },
    field('Site URL', siteInput, 'Where your site runs. A local dev server is the normal answer.'),
    previewSlot,
    field('Web root', publicDirInput, webRootHint),
    el('p', {
      className: 'note',
      text: 'OpenGEO reads this site over HTTP, exactly like an agent would. It never imports your code and never needs to know which framework you use.',
    }),
  );

  // -- step 1: key -------------------------------------------------------------------------------

  const fields = createProviderFields({
    catalog: initial.providerCatalog,
    keyLabel: 'API key',
    keyHint: 'Leave blank to skip.',
    onChange: () => {
      keyEdited = true;
      drawNav();
    },
  });
  fields.set(draftFromState(initial));
  const endpointLabel = el('strong');
  const keyPath = el('span', { className: 'mono' });

  const keyStep = el(
    'div',
    { className: 'contents', hidden: true },
    el('p', {
      className: 'muted',
      style: { margin: '0' },
      text: 'Optional. Everything except the AI generate tier and the content review works without a key, and you can add one later in Settings.',
    }),
    fields.node,
    el(
      'p',
      { className: 'note' },
      'Not on the list? Pick ',
      endpointLabel,
      ' and give it a base URL. Anything speaking the OpenAI, Anthropic or Gemini request format works.',
    ),
    banner(
      { tone: 'info', title: 'Where it goes' },
      'Into ',
      keyPath,
      ', after ',
      el('span', { className: 'mono', text: '.env' }),
      ' is added to .gitignore. The only request it is ever attached to is the direct call to the provider above.',
    ),
  );

  // -- step 2: bots ------------------------------------------------------------------------------

  const modes = createRoutingModes({
    onPick: (next) => {
      mode = next;
      routing = routingForMode(next, routable(), routing);
      if (next !== 'custom') adder.close();
      drawBots();
    },
  });
  const checklist = createCrawlerChecklist({
    onToggle: (name) => {
      routing = toggled(routing, name);
      drawBots();
    },
    onRemove: (name) => {
      custom = custom.filter((bot) => bot.name !== name);
      routing = routing.filter((entry) => entry !== name);
      drawBots();
    },
  });
  // Every crawler shown, robots.txt-only built-ins included, so a duplicate name is caught here
  // rather than merged or refused by the server on Finish.
  const adder = createAddCrawler({
    existing: () => shown().map((bot) => bot.name),
    onAdd: (bot) => {
      custom = [...custom, bot];
      routing = [...routing, bot.name];
      drawBots();
    },
  });
  const pickBlock = el('div', { className: 'contents', hidden: true }, checklist.node, adder.node);
  const countNote = el('p', { className: 'note' });

  const botsStep = el(
    'div',
    { className: 'contents', hidden: true },
    el('p', {
      className: 'muted',
      style: { margin: '0' },
      text: 'Which agents receive the markdown twin instead of HTML. This is a format decision, not an access one: anyone unticked, and anyone not on this list at all, sees the ordinary site. Blocking is a separate, opt-in setting under Bot settings.',
    }),
    modes.node,
    pickBlock,
    countNote,
  );

  // -- the step card and its navigation ----------------------------------------------------------

  const stepHead = cardHead({ title: STEPS[0], sub: ' ' });
  const stepTitle = /** @type {HTMLElement} */ (stepHead.querySelector('h2'));
  const stepSub = /** @type {HTMLElement} */ (stepHead.querySelector('.sub'));
  // Focus moves here on Next, Back and Skip. The button that was pressed may have just been hidden
  // or disabled, and a keyboard or screen reader user would otherwise be left on nothing.
  stepTitle.tabIndex = -1;
  const stepError = el('div', { className: 'contents' });

  const backButton = button({ label: 'Back', onClick: () => go(step - 1) });
  const nextButton = button({ label: 'Next', primary: true, onClick: () => go(step + 1) });
  const finishButton = button({ label: 'Finish', primary: true, onClick: () => void finish() });

  const stepScreen = el(
    'div',
    { className: 'contents' },
    card('', stepHead, el('div', { className: 'card-pad stack' }, projectStep, keyStep, botsStep, stepError)),
    el('div', { className: 'row' }, backButton, el('div', { className: 'grow' }), nextButton, finishButton),
  );
  const panels = [projectStep, keyStep, botsStep];

  // -- the closing screen ------------------------------------------------------------------------

  const savedHead = cardHead({ title: 'Where you stand', sub: ' ' });
  const savedTitle = /** @type {HTMLElement} */ (savedHead.querySelector('h2'));
  const savedSub = /** @type {HTMLElement} */ (savedHead.querySelector('.sub'));
  savedTitle.tabIndex = -1;
  const savedSite = el('span', { className: 'mono' });
  // Onboarding used to show a bare spinner here. It is the same streamed run the Test tab narrates,
  // so it gets the same panel.
  const progress = createProgress('Fetching the site and running the structural checks...');
  const resultSlot = el('div', { className: 'contents' });
  const savedError = el('div', { className: 'contents' });
  const openButton = button({
    label: 'Open the dashboard',
    primary: true,
    onClick: () => {
      stopProbe();
      onDone(result);
    },
  });

  const savedScreen = el(
    'div',
    { className: 'contents', hidden: true },
    card(
      '',
      savedHead,
      el(
        'div',
        { className: 'card-pad stack' },
        el(
          'p',
          { className: 'muted', style: { margin: '0' } },
          'Saved. This is ',
          savedSite,
          ' against the structural checks, run just now. Nothing was uploaded.',
        ),
        progress.node,
        resultSlot,
        savedError,
      ),
    ),
    el('div', { className: 'row' }, el('div', { className: 'grow' }), openButton),
  );

  const node = el(
    'div',
    { className: 'onboarding' },
    el(
      'div',
      { className: 'onboarding-card' },
      el(
        'div',
        {},
        el('h1', { className: 'onboarding-title', text: 'Set up OpenGEO' }),
        el('p', { className: 'muted', style: { margin: '0' } }, 'Three questions, then a first result. Everything is written into ', rootPath, '.'),
      ),
      el('div', { className: 'steps', attrs: { 'aria-hidden': 'true' } }, dots),
      stepScreen,
      savedScreen,
    ),
  );

  // -- the site preview --------------------------------------------------------------------------

  /** @type {SitePreview | undefined} */
  let preview;
  let probing = false;
  // Each check takes a number, and only the newest may draw. The abort below closes the older
  // request, but a reply already parsed can still be on its way through the promise chain.
  let probeTicket = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let probeTimer;
  /** @type {AbortController | undefined} */
  let probeController;
  let previewDrawn = '';

  function stopProbe() {
    probeTicket += 1;
    clearTimeout(probeTimer);
    probeTimer = undefined;
    probeController?.abort();
    probeController = undefined;
  }

  /**
   * The URL probed while it is being typed, without a request per keystroke.
   *
   * The previous answer is cleared the moment a new check starts: leaving it up would describe a
   * URL that is no longer in the field. Errors are swallowed on purpose. This is a convenience on
   * top of a field that works fine without it, and a red box about a URL somebody is halfway through
   * typing would be worse than showing nothing at all.
   */
  function probe() {
    stopProbe();
    preview = undefined;
    const target = siteInput.value.trim();
    probing = probeable(target);
    drawPreview();
    if (!probing) return;

    const ticket = probeTicket;
    probeTimer = setTimeout(() => {
      const controller = new AbortController();
      probeController = controller;
      api.preview(target, controller.signal).then(
        (response) => {
          if (ticket !== probeTicket) return;
          preview = response.preview;
          probing = false;
          drawPreview();
        },
        () => {
          if (ticket !== probeTicket) return;
          preview = undefined;
          probing = false;
          drawPreview();
        },
      );
    }, PREVIEW_DELAY_MS);
  }

  function drawPreview() {
    const key = JSON.stringify([probing, preview ?? null]);
    if (key === previewDrawn) return;
    previewDrawn = key;
    fill(previewSlot, previewNote(preview, probing));
  }

  // -- behaviour ---------------------------------------------------------------------------------

  function shown() {
    return shownBots(ctx.bots(), custom);
  }

  function routable() {
    return routableOnly(shown());
  }

  /** @param {number} next */
  function go(next) {
    if (next < 0 || next >= STEPS.length || next === step) return;
    step = next;
    draw();
    stepTitle.focus();
  }

  function draft() {
    return fields.get();
  }

  async function finish() {
    if (busy) return;
    const state = ctx.state();
    const current = draft();
    const info = providerInfoOf(state.providerCatalog, current.provider);
    const site = siteInput.value.trim();
    busy = true;
    error = undefined;
    draw();
    try {
      if (keyStepSaves(current, info, state.key, keyEdited)) {
        // A blank key goes as '' on purpose: when a key for this provider is already saved, the
        // server keeps it and updates only the model and endpoint.
        await api.saveKey({
          provider: current.provider,
          apiKey: current.apiKey.trim(),
          model: current.model,
          baseUrl: current.baseUrl || undefined,
          api: info?.userDefined ? current.api : undefined,
          auth: info?.keyless ? 'none' : undefined,
        });
      }
      await api.saveConfig({
        site,
        publicDir: publicDirInput.value.trim() || state.config.publicDir,
        bots: { markdownRouting: routing, blocked: state.config.bots.blocked, custom },
      });
    } catch (thrown) {
      error = messageOf(thrown);
      busy = false;
      draw();
      return;
    }

    // Saved. From here nothing can fail in a way that should undo the setup, so the score runs on
    // its own and a failure to reach the site is reported as a finding rather than as an error.
    busy = false;
    saved = true;
    scoring = true;
    finishedSite = site;
    progress.set(undefined);
    draw();
    // The Finish button has just gone with the form it closed.
    savedTitle.focus();
    try {
      result = await startRun('test', (signal) => api.test({ url: site, mode: 'structure' }, progress.set, signal));
    } catch (thrown) {
      // The page is closing. There is nobody to tell.
      if (!isAbort(thrown)) error = messageOf(thrown);
    }
    scoring = false;
    draw();
  }

  function draw() {
    dots.forEach((dot, index) => dot.classList.toggle('done', saved || index <= step));
    stepScreen.hidden = saved;
    savedScreen.hidden = !saved;
    if (saved) {
      drawSaved();
      return;
    }

    setText(stepTitle, STEPS[step] ?? '');
    setText(stepSub, `Step ${step + 1} of ${STEPS.length}`);
    panels.forEach((panel, index) => {
      panel.hidden = index !== step;
    });
    fill(stepError, error ? banner({ tone: 'fail' }, error) : null);
    drawNav();
    drawBots();
  }

  function drawNav() {
    const state = ctx.state();
    const current = draft();
    const info = providerInfoOf(state.providerCatalog, current.provider);
    const last = step === STEPS.length - 1;
    setBusy(backButton, false, step === 0 || busy);
    nextButton.hidden = last;
    finishButton.hidden = !last;
    // "Skip" only when leaving the step really writes nothing for it.
    setLabel(nextButton, step === 1 && !keyStepSaves(current, info, state.key, keyEdited) ? 'Skip' : 'Next');
    setBusy(
      nextButton,
      false,
      (step === 0 && !siteInput.value.trim()) || (step === 1 && !keyStepReady(current, info, state.key, keyEdited)),
    );
    setBusy(finishButton, busy);
  }

  function drawBots() {
    const list = routable();
    modes.update(mode, list);
    pickBlock.hidden = mode !== 'custom';
    countNote.hidden = mode === 'custom';
    if (mode === 'custom') checklist.update(list, routing);
    setText(
      countNote,
      `${routing.length} of ${list.length} agents. Pick "Let me pick" to choose them by name, or to add a crawler OpenGEO has never heard of.`,
    );
  }

  function drawSaved() {
    const score = result?.score;
    setText(savedSite, finishedSite);
    const sub = scoring ? 'Running the structural test' : score ? `${score.earned} of ${score.possible} points across the scored checks` : '';
    setText(savedSub, sub);
    savedSub.hidden = !sub;
    progress.node.hidden = !scoring;
    setBusy(openButton, false, scoring);

    fill(resultSlot, result && score ? closingScore(result, score, ctx.state()) : null);
    fill(
      savedError,
      error && !scoring
        ? banner({ tone: 'warn', title: 'The score did not run' }, `${error} The settings are saved, and Test in the dashboard will try again.`)
        : null,
    );
  }

  draw();
  probe();

  return {
    node,
    update() {
      const state = ctx.state();
      setText(rootPath, state.root);
      setText(
        webRootHint,
        state.webRoot.found ? `Where generated files land. ${state.webRoot.why}.` : `Where generated files land. Default: ${state.config.publicDir}`,
      );
      publicDirInput.placeholder = state.config.publicDir;
      // Untouched fields follow the server; anything typed is left exactly as it is.
      if (!siteEdited && siteInput.value !== state.config.site) {
        siteInput.value = state.config.site;
        probe();
      }
      if (!publicDirEdited) publicDirInput.value = webRootGuess(state);
      if (!keyEdited) fields.set(draftFromState(state));
      setText(keyPath, state.key.path);
      setText(endpointLabel, customEndpointLabel(state.providerCatalog));
      if (!saved) draw();
      // `autofocus` is only honoured for markup present at load, and this node arrives later. Focus
      // goes to the Site URL field the first time the screen is actually in a document.
      if (!autofocused && node.isConnected && step === 0 && !saved) {
        autofocused = true;
        siteInput.focus();
      }
    },
  };
}

/**
 * The same starting draft Settings uses. The endpoint comes from the config, so a blank key over a
 * saved one is sent with the base URL the server will compare it against.
 *
 * @param {StateResponse} state
 * @returns {ProviderDraft}
 */
function draftFromState(state) {
  return {
    ...draftForProvider(state.providerCatalog, state.key.provider ?? state.config.ai.provider),
    model: state.key.model ?? state.config.ai.model,
    baseUrl: state.config.ai.baseUrl ?? '',
    api: state.config.ai.api ?? 'openai',
  };
}

/**
 * @param {StateResponse} state
 * @returns {string}
 */
function webRootGuess(state) {
  return state.webRoot.found ? state.webRoot.dir : state.config.publicDir;
}

/**
 * @param {TestResponse} result
 * @param {NonNullable<TestResponse['score']>} score
 * @param {StateResponse} state
 */
function closingScore(result, score, state) {
  const next = nextFixes(result.checks ?? []);
  const faults = twinFaultIds(result.checks ?? []);
  const title =
    next[0]?.scored ? 'Do this next (most points first)'
    : next[0] && faults.has(next[0].id) ? 'Fix the twin next (outside the score, but agents are sent it wrong)'
    : 'Worth adopting next (outside the score)';
  return [
    scorePanel({ score, url: result.url, framework: result.framework, history: result.history, bands: state.bands.structural }),
    next.length > 0
      ? el(
          'div',
          {},
          el('div', { className: 'group-title', text: title }),
          next.map((check) =>
            el(
              'div',
              { className: check.scored ? 'check' : faults.has(check.id) ? 'check check-suggestion check-fault' : 'check check-suggestion' },
              el('div', { className: 'check-id', text: check.id }),
              el('div', {}, el('div', { className: 'check-title', text: check.title }), el('div', { className: 'check-reason', text: check.fix ?? check.reason })),
              // A scored fix is priced in score points, the dial's unit. A suggestion moves no score.
              el('div', { className: 'check-points', text: check.scored ? `+${check.price ?? check.weight - check.earned}` : faults.has(check.id) ? 'fix' : 'tip' }),
            ),
          ),
        )
      : banner({ tone: 'ok', title: 'Nothing to fix' }, 'Every check that applies passed on the first run.'),
  ];
}

/**
 * The probe under the URL field, saying the same things the terminal says.
 *
 * Never an error banner, whatever it finds. Nothing here blocks setup: the URL is saved either way,
 * and the reason to show this at all is that "we cannot reach that" is worth knowing while the field
 * still has focus rather than after the first generate. A URL half-typed is the normal state of this
 * field, so it shows nothing until there is an answer about a whole one.
 *
 * @param {SitePreview | undefined} preview
 * @param {boolean} pending
 * @returns {HTMLElement | null}
 */
export function previewNote(preview, pending) {
  if (pending) return el('p', { className: 'note note-sm', text: 'Checking that URL...' });
  if (!preview) return null;

  if (preview.error) {
    return note(el('div', {}, pill('warn', 'no answer'), ` Could not reach it: ${preview.error}. Saved either way, and nothing else in setup depends on it.`));
  }
  if (!preview.ok) {
    return note(
      el('div', {}, pill('warn', String(preview.status)), ` That URL answered ${preview.status}. Worth a second look, though the rest of setup does not depend on it.`),
    );
  }

  const twin = preview.twin;
  return note(
    el('div', {}, pill('ok', 'reachable'), ` ${preview.status} in ${preview.ttfbMs}ms`, preview.framework ? `, ${preview.framework}` : ''),
    preview.clientRendered
      ? el('div', {
          text: 'The raw HTML is an empty mount element, so the content only exists once JavaScript has run. Agents mostly do not run it, and neither does generate. Server-rendering is the fix.',
        })
      : null,
    twin?.served
      ? el('div', {}, 'A markdown twin is already being served at ', el('span', { className: 'mono', text: twin.url }), ', by opengeo-prod.')
      : twin?.ok
        ? el('div', {}, 'Something already answers at ', el('span', { className: 'mono', text: twin.url }), ", without OpenGEO's headers.")
        : twin
          ? el('div', {}, 'No twin at ', el('span', { className: 'mono', text: twin.url }), ' yet. That is what generate and prod are for.')
          : null,
  );
}

// A column, so each child is a line. A pill and its sentence go in one child, or the pill is
// stretched across the width as a line of its own.
/** @param {...import('../ui.js').Child} children */
function note(...children) {
  return el('div', { className: 'stack-sm note note-sm probe-lines' }, ...children);
}
