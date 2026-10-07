import { writeFileSync } from 'node:fs';
import { resolveBots } from '../../shared/bots.js';
import { c, terminalSafe } from '../../shared/log.js';
import { resolveAiCall } from '../../shared/ai-call.js';
import { internalDirPath } from '../../shared/config.js';
import { isCI } from '../../shared/env.js';
import { ERRORS } from '../../shared/errors.js';
import {
  buildFixPrompt,
  readHistory,
  recordRun,
  renderContentReport,
  renderDiscovery,
  renderReport,
  runTestSuite,
  suiteExitCode,
  suiteJson,
  testUrl,
} from '../../test/index.js';
import { parseArgs } from '../args.js';
import { createProgress } from '../progress.js';
import { resolveProject, resolveTarget } from '../project.js';

/**
 * @import { History, SuiteAi, SuiteProgress, SuiteResult, TestMode } from '../../test/index.js'
 * @import { CommandContext } from '../index.js'
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
  booleans: ['json', 'verbose', 'quality', 'no-quality', 'prompt', 'structure', 'offline', 'content'],
  strings: ['project', 'out', 'timeout', 'provider', 'model', 'max-docs'],
  alias: { v: 'verbose', q: 'quality', nq: 'no-quality' },
});

/**
 * @param {CommandContext} ctx
 * @returns {Promise<number>}
 */
export async function testCommand(ctx) {
  const args = parseArgs(ctx.argv, SPEC);
  const unknown = args.unknown();
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option${unknown.length === 1 ? '' : 's'}: ${unknown.map((n) => `--${n}`).join(', ')}\n`);
    return 1;
  }

  const loaded = resolveProject(args);
  const target = resolveTarget(args, loaded, 'test');
  const bots = resolveBots(loaded.config.bots.custom);
  const markdownRouting = loaded.config.bots.markdownRouting;
  const timeoutMs = args.num('timeout');

  // --prompt replaces the report rather than appending to it: the whole output is meant to be
  // selected and pasted into a coding agent, so anything else in the buffer is in the way. It is
  // also structural by definition - a model's opinion is not a checklist an agent can work through.
  if (args.bool('prompt')) {
    const result = await testUrl(target.toString(), { timeoutMs, bots, markdownRouting });
    const prompt = buildFixPrompt(result, { command: `opengeo test ${target.toString()}` });
    return writeOut(prompt, args.str('out'), result.score.counts.fail === 0 ? 0 : 1);
  }

  const mode = resolveMode(args);
  if (typeof mode !== 'string') {
    process.stderr.write(`${mode.error}\n`);
    return 1;
  }

  const ai = resolveAi(args, loaded);
  if (ai.error) {
    process.stderr.write(`${ai.error}\n`);
    return 1;
  }

  const json = args.bool('json');
  // Read before the run, so the headline can say what moved. `recordRun` appends afterwards.
  const internalDir = internalDirPath(loaded);
  const history = readHistory(internalDir);
  const printer = json ? undefined : progressPrinter(args.bool('verbose'), history);
  const result = await runTestSuite(target.toString(), {
    mode,
    timeoutMs,
    bots,
    markdownRouting,
    ai: ai.ai,
    // -q means "I want the review", so a missing key becomes a refusal instead of a footnote.
    requireContent: args.bool('quality'),
    maxDocs: args.num('max-docs'),
    onProgress: printer?.onProgress,
  });
  printer?.close();
  // Best-effort and last: a run that scored is worth remembering, and a filesystem that will not
  // take the file is not worth failing a passing audit over. `recordRun` swallows its own errors.
  // Its one warning goes to stderr, so a --json run's stdout stays clean.
  recordRun(internalDir, result, { onWarning: (message) => process.stderr.write(`${message}\n`) });

  if (json) return writeOut(`${suiteJson(result)}\n`, args.str('out'), suiteExitCode(result));

  // The structural report has already been printed by the progress printer, so that a long content
  // pass never hides the half of the answer that is already known.
  writeContent(result);
  return suiteExitCode(result);
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
    return { error: 'Pick one: --structure runs the checks only, --content runs the AI review only, and neither runs both.' };
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
    writeFileSync(out, text, 'utf8');
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
 * @returns {{ onProgress: (event: SuiteProgress) => void; close: () => void }}
 */
function progressPrinter(verbose, history) {
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
        process.stdout.write(renderReport(event.result, { verbose, history }));
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
 * @returns {void}
 */
function writeContent(result) {
  // A provider's error body can end up in contentError, and it is the provider's text, not ours.
  result = terminalSafe(result);
  if (result.mode === 'content' && result.discovery) {
    process.stdout.write(renderDiscovery(result.discovery));
  }
  if (result.content) {
    process.stdout.write(renderContentReport(result.content, result.discovery));
  }
  if (result.contentSkipped) {
    process.stdout.write(`\n${c.gray('Content review skipped.')}\n${result.contentSkipped}\n\n`);
  }
  if (result.contentError) {
    process.stdout.write(`${c.yellow('Content review failed.')}\n${result.contentError}\n\n`);
  }
}

/**
 * @typedef {object} AiChoice
 * @property {SuiteAi} [ai]
 * @property {string} [error] A flag the user got wrong. Fatal, unlike a missing key, which the suite
 *   reports in context.
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
  if (isCI()) return {};

  const resolved = resolveAiCall(loaded.root, loaded.config, { provider: args.str('provider'), model: args.str('model') });
  if ('error' in resolved) return resolved;
  if ('missing' in resolved) return {};
  const { keySource: _source, ...ai } = resolved.call;
  return { ai };
}
