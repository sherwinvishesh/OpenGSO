import { writeFileSync } from 'node:fs';
import { resolveBots } from '../../shared/bots.js';
import { c } from '../../shared/log.js';
import { providerOverridesOf } from '../../shared/config.js';
import type { AiProvider } from '../../shared/providers.js';
import { AI_PROVIDERS, DEFAULT_MODELS, isAiProvider, providerInfo } from '../../shared/providers.js';
import { isCI, readCredentials } from '../../shared/env.js';
import { ERRORS } from '../../shared/errors.js';
import type { SuiteAi, SuiteProgress, SuiteResult, TestMode } from '../../test/index.js';
import {
  buildFixPrompt,
  renderContentReport,
  renderDiscovery,
  renderReport,
  runTestSuite,
  suiteExitCode,
  suiteJson,
  testUrl,
} from '../../test/index.js';
import { parseArgs } from '../args.js';
import type { CommandContext } from '../index.js';
import { resolveProject, resolveTarget } from '../project.js';

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

const SPEC = {
  booleans: ['json', 'verbose', 'quality', 'no-quality', 'prompt', 'structure', 'offline', 'content'],
  strings: ['project', 'out', 'timeout', 'provider', 'model', 'max-docs'],
  alias: { v: 'verbose', q: 'quality', nq: 'no-quality' },
} as const;

export async function testCommand(ctx: CommandContext): Promise<number> {
  const args = parseArgs(ctx.argv, SPEC);
  const unknown = args.unknown();
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option${unknown.length === 1 ? '' : 's'}: ${unknown.map((n) => `--${n}`).join(', ')}\n`);
    return 1;
  }

  const loaded = resolveProject(args);
  const target = resolveTarget(args, loaded, 'test');
  const bots = resolveBots(loaded.config.bots.custom);
  const timeoutMs = args.num('timeout');

  // --prompt replaces the report rather than appending to it: the whole output is meant to be
  // selected and pasted into a coding agent, so anything else in the buffer is in the way. It is
  // also structural by definition - a model's opinion is not a checklist an agent can work through.
  if (args.bool('prompt')) {
    const result = await testUrl(target.toString(), { timeoutMs, bots });
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
  const result = await runTestSuite(target.toString(), {
    mode,
    timeoutMs,
    bots,
    ai: ai.ai,
    // -q means "I want the review", so a missing key becomes a refusal instead of a footnote.
    requireContent: args.bool('quality'),
    maxDocs: args.num('max-docs'),
    onProgress: json ? undefined : progressPrinter(args.bool('verbose')),
  });

  if (json) return writeOut(`${suiteJson(result)}\n`, args.str('out'), suiteExitCode(result));

  // The structural report has already been printed by the progress printer, so that a long content
  // pass never hides the half of the answer that is already known.
  writeContent(result);
  return suiteExitCode(result);
}

type ModeChoice = TestMode | { error: string };

/**
 * Flags to a mode.
 *
 * `-q` and `-nq` are kept as the pair people already type, and are defined in terms of the modes
 * rather than as a third switch: `-nq` is exactly `--structure`, and `-q` is the full run with the
 * content pass promoted from "if a key happens to exist" to "required".
 */
export function resolveMode(args: { bool: (name: string) => boolean }): ModeChoice {
  const structure = args.bool('structure') || args.bool('offline') || args.bool('no-quality');
  const content = args.bool('content');
  if (structure && content) {
    return { error: 'Pick one: --structure runs the checks only, --content runs the AI review only, and neither runs both.' };
  }
  if (content) return 'content';
  if (structure) return 'structure';
  return 'full';
}

function writeOut(text: string, out: string | undefined, code: number): number {
  if (out) {
    writeFileSync(out, text, 'utf8');
    process.stdout.write(`${c.gray(`Wrote ${out}`)}\n`);
  } else {
    process.stdout.write(text);
  }
  return code;
}

/**
 * Narration for the content pass.
 *
 * Reviewing ten documents is ten sequential provider calls and can take a minute or more. A tool
 * that prints nothing for that long looks hung, and the honest fix is to say what it is doing.
 */
function progressPrinter(verbose: boolean): (event: SuiteProgress) => void {
  return (event) => {
    switch (event.phase) {
      case 'structure-done':
        process.stdout.write(renderReport(event.result, { verbose }));
        break;
      case 'discover':
        process.stdout.write(`${c.gray('Looking for Markdown documents...')}\n`);
        break;
      case 'discovered':
        process.stdout.write(`${c.gray(`Found ${event.documents}. Reviewing...`)}\n`);
        break;
      case 'review':
        process.stdout.write(`${c.gray(`  [${event.done}/${event.total}] ${event.url}`)}\n`);
        break;
      default:
        break;
    }
  };
}

function writeContent(result: SuiteResult): void {
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

interface AiChoice {
  ai?: SuiteAi;
  /** A flag the user got wrong. Fatal, unlike a missing key, which the suite reports in context. */
  error?: string;
}

/**
 * Credentials and provider for the content pass (§11).
 *
 * A missing key is deliberately *not* an error here. The suite decides what a missing key means,
 * because it depends on the mode: a note in `full`, a refusal in `content`. What is fatal is a flag
 * that cannot be honoured, like a provider that does not exist.
 */
function resolveAi(args: ReturnType<typeof parseArgs>, loaded: ReturnType<typeof resolveProject>): AiChoice {
  if (isCI()) return {};

  const providerFlag = args.str('provider');
  if (providerFlag && !isAiProvider(providerFlag)) {
    return { error: ERRORS.unknownProvider(providerFlag, AI_PROVIDERS) };
  }

  const credentials = readCredentials(loaded.root);
  const provider =
    (providerFlag as AiProvider | undefined) ?? credentials?.provider ?? loaded.config.ai.provider ?? 'anthropic';
  // A local model server has no key to find, so "no credentials" is not the same as "cannot run".
  if (!credentials && !isKeyless(provider)) return {};

  const model = args.str('model') || credentials?.model || loaded.config.ai.model || DEFAULT_MODELS[provider];
  return {
    ai: {
      provider,
      apiKey: credentials?.apiKey ?? '',
      model,
      overrides: { ...providerOverridesOf(loaded.config), baseUrl: credentials?.baseUrl ?? loaded.config.ai.baseUrl },
    },
  };
}

function isKeyless(provider: AiProvider): boolean {
  try {
    return Boolean(providerInfo(provider).keyless);
  } catch {
    return false;
  }
}
