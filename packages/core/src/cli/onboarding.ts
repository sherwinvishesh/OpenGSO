import { internalDirPath } from '../shared/config.js';
import { resolveBots } from '../shared/bots.js';
import { c } from '../shared/log.js';
import { recordRun } from '../test/history.js';
import { renderSetupScore } from '../test/report.js';
import { runTestSuite } from '../test/suite.js';
import type { SetupMode, SetupResult } from './configure.js';
import { runSetup } from './configure.js';
import type { Prompter } from './prompt.js';
import { createPrompter } from './prompt.js';
import { previewSite } from '../shared/site-probe.js';
import type { Stepper } from './stepper.js';
import { openStepper } from './stepper.js';
import { canUseTui } from './tui/screen.js';

/**
 * The one place that decides what setup looks like, shared by `start`, `settings` and the home
 * screen's "Set up this project".
 *
 * Both commands used to build a `createPrompter` and hand it to `runSetup`, which was fine while
 * setup was four questions on a scrolling terminal. It is now three things layered on the same
 * four questions - a full-screen stepper, a probe of the URL as it is typed, and a real score at
 * the end - and none of those belong to `start` or to `settings` specifically. Putting them in
 * either would have meant the other one either missed them or copied them.
 *
 * Every layer is optional and every layer degrades. No TTY, `CI=1`, `--yes` or a pipe and this is
 * the flat readline flow that has always been here, with no probe and no closing test, byte for
 * byte. That is the whole reason the stepper was written as a `Prompter` rather than as a second
 * onboarding flow.
 */

export interface OnboardingOptions {
  root: string;
  mode: SetupMode;
  /** `--yes`. Takes every default without asking, so it also skips the probe and the closing test. */
  autoAccept?: boolean;
  /** What the frame's top-right corner says, e.g. `opengeo 0.4.0`. */
  tag?: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export async function runOnboarding(options: OnboardingOptions): Promise<SetupResult> {
  const { root, mode, autoAccept } = options;
  const interactive = !autoAccept;
  const stepper = interactive ? openStepper({ input: options.input, output: options.output, tag: options.tag }) : undefined;
  const prompter: Prompter = stepper?.prompter ?? createPrompter({ autoAccept, input: options.input, output: options.output });
  const output = options.output ?? process.stdout;
  const write = stepper ? (text: string) => stepper.write(text) : (text: string) => void output.write(text);

  try {
    return await runSetup({
      root,
      prompter,
      mode,
      out: write,
      // Six seconds of network at most, and only when somebody is sitting there to read the answer.
      preview: interactive ? (url) => previewSite(url).then((result) => result, () => undefined) : undefined,
      // Only on a first run. Somebody in `settings` changing one crawler did not ask to be scored,
      // and running a test at the end of every edit would make the menu feel like a build step.
      finish: interactive && mode === 'first-run' ? (result) => scoreOnFinish(result, write, Boolean(stepper)) : undefined,
    });
  } finally {
    prompter.close();
    // After the frame is gone, so the report lands in scrollback where it can be scrolled and
    // copied, exactly like the report a `opengeo test` prints.
    stepper?.close();
  }
}

/**
 * Setup's last screen: the score the site has right now.
 *
 * Deliberately structural only. A content review costs money and needs a key that most people will
 * not have just added, and a setup flow whose final step spends money is a setup flow people learn
 * to interrupt. The number this prints is the same number `opengeo test` would print one second
 * later, which is the point: nothing here is a preview or an estimate.
 *
 * A failed run is not an error. The site may not be running yet - the probe two steps earlier will
 * already have said so - and setup has finished successfully either way.
 */
async function scoreOnFinish(result: SetupResult, write: (text: string) => void, framed: boolean): Promise<void> {
  const { config, root } = result;
  write(`\n${c.bold('Where you stand')}\n`);
  write(`  ${c.gray(`Running the structural test against ${config.site}. Nothing is uploaded.`)}\n`);

  try {
    const suite = await runTestSuite(config.site, { mode: 'structure', bots: resolveBots(config.bots.custom) });
    if (!suite.structure) return;
    // Recorded like any other run, so the home screen has a score to show the moment setup ends and
    // the next test can print a delta against this one.
    recordRun(internalDirPath({ root, config }), suite);
    // Inside the frame the buffer is 12 lines, and the report is longer than that; the stepper
    // flushes whatever is left to scrollback on close, so this is written once and read there.
    write(renderSetupScore(suite.structure, { width: framed ? 80 : undefined }));
    write(`${c.gray(`Re-run it any time with \`opengeo test ${config.site}\`, or just \`opengeo\`.\n`)}`);
  } catch (error) {
    write(`  ${c.yellow(`Could not test the site yet: ${error instanceof Error ? error.message : String(error)}`)}\n`);
    write(`  ${c.gray(`Setup is finished regardless. Run \`opengeo test ${config.site}\` once the site is up.`)}\n`);
  }
}

/** Re-exported so a caller only has to know about this module to know whether it will draw a frame. */
export { canUseTui };
export type { Stepper };
