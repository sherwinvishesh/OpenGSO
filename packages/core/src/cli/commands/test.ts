import { writeFileSync } from 'node:fs';
import { c } from '../../shared/log.js';
import { AI_PROVIDERS, DEFAULT_MODELS } from '../../shared/config.js';
import type { AiProvider } from '../../shared/config.js';
import { isCI, readCredentials } from '../../shared/env.js';
import { ERRORS } from '../../shared/errors.js';
import type { QualityReview, TestResult } from '../../test/index.js';
import { buildFixPrompt, renderQuality, renderReport, reviewQuality, testUrl, toJson } from '../../test/index.js';
import { parseArgs } from '../args.js';
import type { CommandContext } from '../index.js';
import { resolveProject, resolveTarget } from '../project.js';

const SPEC = {
  booleans: ['json', 'verbose', 'quality', 'prompt'],
  strings: ['project', 'out', 'timeout', 'provider', 'model'],
  alias: { v: 'verbose' },
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
  const result = await testUrl(target.toString(), { timeoutMs: args.num('timeout') });

  // --prompt replaces the report rather than appending to it: the whole output is meant to be
  // selected and pasted into a coding agent, so anything else in the buffer is in the way.
  if (args.bool('prompt')) {
    const prompt = buildFixPrompt(result, { command: `opengeo test ${target.toString()}` });
    return writeOut(prompt, args.str('out'), result);
  }

  const quality = args.bool('quality') ? await runQuality(result, args, loaded.root) : undefined;

  if (args.bool('json')) {
    return writeOut(`${toJson(result, quality?.review)}\n`, args.str('out'), result);
  }

  process.stdout.write(renderReport(result, { verbose: args.bool('verbose') }));
  if (quality) {
    process.stdout.write(quality.review ? renderQuality(quality.review) : `${c.yellow('Content quality')} ${quality.error}\n\n`);
  }
  return result.score.counts.fail === 0 ? 0 : 1;
}

function writeOut(text: string, out: string | undefined, result: TestResult): number {
  if (out) {
    writeFileSync(out, text, 'utf8');
    process.stdout.write(`${c.gray(`Wrote ${out}`)}\n`);
  } else {
    process.stdout.write(text);
  }
  return result.score.counts.fail === 0 ? 0 : 1;
}

interface QualityOutcome {
  review?: QualityReview;
  error?: string;
}

/**
 * The one place in `test` that needs a key (§11).
 *
 * Every way this can go wrong degrades to a message beside an otherwise complete report, never to a
 * failed command: the structural score is the product, and it was already computed before we got
 * here. Losing it because a provider timed out would be the wrong trade.
 */
async function runQuality(result: TestResult, args: ReturnType<typeof parseArgs>, root: string): Promise<QualityOutcome> {
  if (isCI()) return { error: ERRORS.ciBlocked('test --quality') };

  const credentials = readCredentials(root);
  if (!credentials) return { error: ERRORS.noApiKey('test --quality') };

  const providerFlag = args.str('provider');
  if (providerFlag && !AI_PROVIDERS.includes(providerFlag as AiProvider)) {
    return { error: ERRORS.unknownProvider(providerFlag, AI_PROVIDERS) };
  }
  const provider = (providerFlag as AiProvider | undefined) ?? credentials.provider ?? 'anthropic';
  const model = args.str('model') || credentials.model || DEFAULT_MODELS[provider];

  const markdown = result.evidence.twin.body.trim();
  if (!markdown) {
    return { error: `There is no markdown at ${result.twinUrl} to review. Fix the failing B checks first, then re-run with --quality.` };
  }

  try {
    const review = await reviewQuality({ url: result.twinUrl, markdown }, { provider, model, apiKey: credentials.apiKey });
    return { review };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
