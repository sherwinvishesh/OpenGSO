import { writeFileSync } from 'node:fs';
import { resolveBots } from '../../shared/bots.js';
import { c, terminalSafe } from '../../shared/log.js';
import { resolveAiCall } from '../../shared/ai-call.js';
import { copyToClipboard } from '../../shared/clipboard.js';
import { internalDirPath } from '../../shared/config.js';
import { isCI } from '../../shared/env.js';
import { ERRORS } from '../../shared/errors.js';
import { AI_PROVIDERS, isAiProvider } from '../../shared/providers.js';
import {
  buildFixPrompt,
  CHECKS,
  fixPromptOptions,
  fixPromptSummary,
  readHistory,
  recordRun,
  renderContentReport,
  renderDiscovery,
  renderReport,
  runTestSuite,
  failsBuild,
  suiteExitCode,
  suiteJson,
  testUrl,
} from '../../test/index.js';
import { EXIT_USAGE, parseArgs } from '../args.js';
import { createProgress } from '../progress.js';
import { stripAnsi } from '../../shared/render/paint.js';
import { resolveProject, resolveTarget } from '../project.js';

/**
 * @import { History, SuiteAi, SuiteProgress, SuiteResult, TestMode, TestResult } from '../../test/index.js'
 * @import { CommandContext } from '../index.js'
 * @import { LookalikeKey } from '../../shared/env.js'
 */

/**
 * `opengeo test` in three shapes (§5).
 *
 * The default run does the structural audit and then, only if a key is already configured, the AI
 * content review of every Markdown document the site serves. Without a key it prints the structural
 * report and one line saying what it skipped, because the 0-100 score is the product and it has
 * never needed a key.
 *
 * `--structure` (or `--offline`) is that first half alone. `--content` is the second half alone, for
 * the loop where you are editing the Markdown and do not need to re-hear that the headers are fine.
 */

const SPEC = /** @type {const} */ ({
  booleans: ['json', 'verbose', 'quality', 'no-quality', 'prompt', 'copy', 'structure', 'offline', 'content', 'strict'],
  strings: ['project', 'out', 'provider', 'model', 'only'],
  numbers: { timeout: { min: 0, exclusive: true }, 'max-docs': { min: 1, integer: true } },
  alias: { v: 'verbose', q: 'quality', nq: 'no-quality' },
});

/**
 * @param {CommandContext} ctx
 * @returns {Promise<number>}
 */
export async function testCommand(ctx) {
  const args = parseArgs(ctx.argv, SPEC);
  const problem = args.problem();
  if (problem) {
    process.stderr.write(`${problem}\n`);
    return EXIT_USAGE;
  }
  const only = parseOnly(args.str('only'));
  if (only.error) {
    process.stderr.write(`${only.error}\n`);
    return EXIT_USAGE;
  }
  const copy = args.bool('copy');
  // On its own --only would scope a prompt nobody asked for, and silently ignoring it would let a
  // user believe the report had been filtered.
  if (only.ids && !copy && !args.bool('prompt')) {
    process.stderr.write(`${ERRORS.onlyNeedsPrompt}\n`);
    return EXIT_USAGE;
  }

  const loaded = resolveProject(args);
  const target = resolveTarget(args, loaded, 'test');
  const bots = resolveBots(loaded.config.bots.custom);
  const markdownRouting = loaded.config.bots.markdownRouting;
  // Seconds on the command line, like generate and prod test; the pillar wants milliseconds.
  const timeout = args.num('timeout');
  const timeoutMs = timeout === undefined ? undefined : timeout * 1000;
  // Suggestions never fail a build by default. --strict is for a site that has adopted them and
  // wants CI to notice the day the twin stops being served.
  const strict = args.bool('strict');

  // --prompt replaces the report rather than appending to it: the whole output is meant to be
  // selected and pasted into a coding agent, so anything else in the buffer is in the way. It is
  // also structural by definition - a model's opinion is not a checklist an agent can work through.
  const promptOptions = { ...fixPromptOptions(loaded.config, target.toString()), only: only.ids };
  if (args.bool('prompt')) {
    const result = await testUrl(target.toString(), { timeoutMs, bots, markdownRouting });
    const prompt = buildFixPrompt(result, promptOptions);
    const code = writeOut(prompt, args.str('out'), failsBuild(result.checks, { strict }) ? 1 : 0);
    // To stderr, so stdout stays exactly the prompt for anyone piping it somewhere.
    if (copy) await copyPrompt(prompt, fixPromptSummary(result, only.ids), process.stderr);
    return code;
  }

  const mode = resolveMode(args);
  if (typeof mode !== 'string') {
    process.stderr.write(`${mode.error}\n`);
    return EXIT_USAGE;
  }
  if (copy && mode === 'content') {
    process.stderr.write(`${ERRORS.copyNeedsChecks}\n`);
    return EXIT_USAGE;
  }

  const ai = resolveAi(args, loaded);
  if (ai.error) {
    process.stderr.write(`${ai.error}\n`);
    return ai.usage ? EXIT_USAGE : 1;
  }

  const json = args.bool('json');
  // Read before the run, so the headline can say what moved. `recordRun` appends afterwards.
  const internalDir = internalDirPath(loaded);
  const history = readHistory(internalDir);
  // With --out the report is collected for the file and the terminal keeps only the progress.
  const out = args.str('out');
  /** @type {string[]} */
  const report = [];
  /** @type {(text: string) => void} */
  const write = out ? (text) => void report.push(text) : (text) => void process.stdout.write(text);
  // The home screen offers its own key for the prompt, and --copy is about to do it, so neither
  // needs the report's closing line telling them how.
  const promptHint = !copy && !ctx.onFixPrompt;
  const printer = json ? undefined : progressPrinter(args.bool('verbose'), history, write, promptHint);
  /** @type {SuiteResult} */
  let result;
  try {
    result = await runTestSuite(target.toString(), {
      mode,
      timeoutMs,
      bots,
      markdownRouting,
      ai: ai.ai,
      lookalikeKeys: ai.lookalikes,
      // -q means "I want the review", so a missing key becomes a refusal instead of a footnote.
      requireContent: args.bool('quality'),
      maxDocs: args.num('max-docs'),
      onProgress: printer?.onProgress,
    });
  } finally {
    // Also on a throw: a spinner left running redraws over the error printed after it.
    printer?.close();
  }
  // Best-effort and last: a run that scored is worth remembering, and a filesystem that will not
  // take the file is not worth failing a passing audit over. `recordRun` swallows its own errors.
  // Its one warning goes to stderr, so a --json run's stdout stays clean.
  recordRun(internalDir, result, { onWarning: (message) => process.stderr.write(`${message}\n`) });

  const code = suiteExitCode(result, { strict });
  /** @type {TestResult | undefined} */
  const structure = result.structure;
  const prompt = structure ? buildFixPrompt(structure, promptOptions) : undefined;
  if (structure && prompt) ctx.onFixPrompt?.(prompt, fixPromptSummary(structure, only.ids));

  if (json) {
    writeOut(`${suiteJson(result)}\n`, out, code);
  } else {
    // The structural report has already been printed by the progress printer, so that a long content
    // pass never hides the half of the answer that is already known.
    writeContent(result, write);
    if (out) writeOut(report.join(''), out, code);
  }
  // Last, so the confirmation is the final line on screen. stdout carries JSON in a --json run.
  if (copy && structure && prompt) {
    await copyPrompt(prompt, fixPromptSummary(structure, only.ids), json ? process.stderr : process.stdout);
  }
  return code;
}

/**
 * `--only B1,B7` (commas or spaces, any case) as check ids. An id that does not exist is refused by
 * name, because a typo would otherwise be a prompt that quietly says there is nothing to fix.
 *
 * @param {string | undefined} raw
 * @returns {{ ids?: string[]; error?: string }}
 */
export function parseOnly(raw) {
  if (raw === undefined) return {};
  const ids = [...new Set(raw.split(/[\s,]+/).map((id) => id.trim().toUpperCase()).filter(Boolean))];
  /** @type {Set<string>} */
  const known = new Set(CHECKS.map((check) => check.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (ids.length === 0) return { error: ERRORS.onlyEmpty };
  if (unknown.length > 0) return { error: ERRORS.unknownCheckIds(unknown, checkRanges()) };
  return { ids };
}

/**
 * The catalogue as ranges, `A1 to A8 and B1 to B14`, read from it so the message cannot drift.
 *
 * @returns {string}
 */
function checkRanges() {
  /** @type {Map<string, string[]>} */
  const byCategory = new Map();
  for (const check of CHECKS) byCategory.set(check.category, [...(byCategory.get(check.category) ?? []), check.id]);
  const ranges = [...byCategory.values()].map((ids) => (ids.length === 1 ? ids[0] : `${ids[0]} to ${ids[ids.length - 1]}`));
  return ranges.length <= 1 ? ranges.join('') : `${ranges.slice(0, -1).join(', ')} and ${ranges[ranges.length - 1]}`;
}

/**
 * Put the prompt on the clipboard and say what happened, in one line.
 *
 * A clipboard that cannot be reached is a warning and not a failure: the audit ran, its exit code
 * is about the site, and the prompt is one `--prompt` away.
 *
 * @param {string} prompt
 * @param {string} summary
 * @param {NodeJS.WriteStream} stream
 * @returns {Promise<void>}
 */
async function copyPrompt(prompt, summary, stream) {
  // An escape sequence on a stream that is not a terminal would land in somebody's file or pipe.
  const terminal = process.stderr.isTTY ? process.stderr : process.stdout;
  const copied = await copyToClipboard(prompt, { terminal });
  if (!copied.ok) {
    stream.write(`${c.yellow('!')} ${ERRORS.clipboardUnavailable(copied.tried)}\n`);
  } else if (copied.confirmed) {
    stream.write(`${c.green('Copied')} the fix prompt for Claude Code (${summary}). Paste it into your coding agent.\n`);
  } else {
    stream.write(
      `${c.green('Sent')} the fix prompt for Claude Code (${summary}) to ${copied.via}. ` +
        `${c.gray('If nothing pastes, your terminal does not allow it: run with --prompt and copy the output.')}\n`,
    );
  }
}

/** @typedef {TestMode | { error: string }} ModeChoice */

/**
 * Flags to a mode.
 *
 * `-q` and `-nq` are kept as the pair people already type, and are defined in terms of the modes
 * rather than as a third switch: `-nq` is exactly `--structure`, and `-q` is the full run with the
 * content pass promoted from "if a key happens to exist" to "required".
 *
 * @param {{ bool: (name: string) => boolean }} args
 * @returns {ModeChoice}
 */
export function resolveMode(args) {
  const structure = args.bool('structure') || args.bool('offline') || args.bool('no-quality');
  const content = args.bool('content');
  if (structure && content) {
    return { error: ERRORS.modeConflict };
  }
  if (content) return 'content';
  if (structure) return 'structure';
  return 'full';
}

/**
 * @param {string} text
 * @param {string | undefined} out
 * @param {number} code
 * @returns {number}
 */
function writeOut(text, out, code) {
  if (out) {
    // The report was coloured for the terminal it would have gone to. A file is not one.
    writeFileSync(out, stripAnsi(text), 'utf8');
    process.stdout.write(`${c.gray(`Wrote ${out}`)}\n`);
  } else {
    process.stdout.write(text);
  }
  return code;
}

/**
 * Narration, for the two parts of a run that take real time.
 *
 * The structural probe is a dozen requests and the content pass is one provider call per document,
 * so both spend long enough that silence reads as a hang. On a terminal this is one block that
 * redraws; everywhere else it is the same append-only lines it always was.
 *
 * @param {boolean} verbose
 * @param {History} history
 * @param {(text: string) => void} write Where the report goes: stdout, or the buffer for `--out`.
 * @param {boolean} promptHint
 * @returns {{ onProgress: (event: SuiteProgress) => void; close: () => void }}
 */
function progressPrinter(verbose, history, write, promptHint) {
  const progress = createProgress();
  /** @param {SuiteProgress} event */
  const onProgress = (event) => {
    switch (event.phase) {
      case 'structure':
        progress.phase('Auditing the live URL');
        break;
      case 'structure-done':
        // The report is the thing the user came for, so it is printed the moment it exists rather
        // than after a content pass that can take another minute.
        progress.finish();
        write(renderReport(event.result, { verbose, history, promptHint }));
        break;
      case 'discover':
        progress.phase('Looking for Markdown documents');
        break;
      case 'discovered':
        progress.finish(c.gray(`  Found ${event.documents} document${event.documents === 1 ? '' : 's'}.`));
        progress.phase('Reviewing content');
        break;
      case 'review':
        progress.step(event.done, event.total, event.url);
        break;
      default:
        break;
    }
  };
  return { onProgress, close: () => progress.done() };
}

/**
 * @param {SuiteResult} result
 * @param {(text: string) => void} write
 * @returns {void}
 */
function writeContent(result, write) {
  // A provider's error body can end up in contentError, and it is the provider's text, not ours.
  result = terminalSafe(result);
  if (result.mode === 'content' && result.discovery) {
    write(renderDiscovery(result.discovery));
  }
  if (result.content) {
    write(renderContentReport(result.content, result.discovery));
  }
  if (result.contentSkipped) {
    write(`\n${c.gray('Content review skipped.')}\n${result.contentSkipped}\n\n`);
  }
  if (result.contentError) {
    write(`${c.yellow('Content review failed.')}\n${result.contentError}\n\n`);
  }
}

/**
 * @typedef {object} AiChoice
 * @property {SuiteAi} [ai]
 * @property {LookalikeKey[]} [lookalikes] Set when there is no key, for the message to point at a
 *   `.env` line that looks like one under a name OpenGEO does not read.
 * @property {string} [error] A flag the user got wrong. Fatal, unlike a missing key, which the suite
 *   reports in context.
 * @property {boolean} [usage] The error is a `--provider` that does not exist.
 */

/**
 * Credentials and provider for the content pass (§11).
 *
 * A missing key is deliberately *not* an error here. The suite decides what a missing key means,
 * because it depends on the mode: a note in `full`, a refusal in `content`. What is fatal is a flag
 * that cannot be honoured: a provider that does not exist, or one whose only key belongs to another.
 *
 * @param {ReturnType<typeof parseArgs>} args
 * @param {ReturnType<typeof resolveProject>} loaded
 * @returns {AiChoice}
 */
function resolveAi(args, loaded) {
  // Before the CI skip: a provider that does not exist is a mistyped command line wherever it runs,
  // and skipping the content pass there must not turn it into a passing build.
  const provider = args.str('provider');
  if (provider && !isAiProvider(provider)) return { error: ERRORS.unknownProvider(provider, AI_PROVIDERS), usage: true };
  if (isCI()) return {};

  const resolved = resolveAiCall(loaded.root, loaded.config, { provider: args.str('provider'), model: args.str('model') });
  if ('error' in resolved) return resolved;
  if ('missing' in resolved) return { lookalikes: resolved.lookalikes };
  const { keySource: _source, ...ai } = resolved.call;
  return { ai };
}
