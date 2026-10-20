import { statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { c, heading, terminalSafe } from '../../shared/log.js';
import { resolveAiCall } from '../../shared/ai-call.js';
import { isLoopbackUrl, mergeConfig, publicDirPath, saveConfig } from '../../shared/config.js';
import { isCI } from '../../shared/env.js';
import { ERRORS } from '../../shared/errors.js';
import { isHtmlFile, shownPath } from '../../shared/local-pages.js';
import { createAiEnhancer } from '../../generate/ai.js';
import { checkFreshness, staleCounts } from '../../generate/freshness.js';
import { SourceFilesError, generateFromFiles } from '../../generate/local.js';
import { generateSite } from '../../generate/site.js';
import { twinUrlFor } from '../../generate/generate.js';
import { EXIT_USAGE, UsageError, parseArgs } from '../args.js';
import { canRedraw, createProgress } from '../progress.js';
import { terminalWidth, visibleWidth, wrap } from '../../shared/render/paint.js';
import { resolveProject, resolveTarget } from '../project.js';

/**
 * @import { LoadedConfig } from '../../shared/config.js'
 * @import { AiProvider } from '../../shared/providers.js'
 * @import { EnhanceInput, EnhanceOutput } from '../../generate/generate.js'
 * @import { GenerateSiteResult } from '../../generate/site.js'
 * @import { Args } from '../args.js'
 * @import { CommandContext } from '../index.js'
 */

/**
 * What a run reads its pages from.
 *
 * @typedef {{ kind: 'url'; target: URL }
 *   | { kind: 'files'; loaded: LoadedConfig; file?: string; folder: string; command: string; create: boolean; tip: boolean }} Source
 */

const SPEC = /** @type {const} */ ({
  booleans: ['force', 'json', 'single', 'skip-files', 'prune', 'check'],
  strings: ['project', 'tier', 'provider', 'model', 'origin'],
  numbers: {
    timeout: { min: 0, exclusive: true },
    'max-pages': { min: 1, integer: true },
    depth: { min: 0, integer: true },
  },
});

/**
 * @param {CommandContext} ctx
 * @returns {Promise<number>}
 */
export async function generateCommand(ctx) {
  const args = parseArgs(ctx.argv, SPEC);
  const problem = args.problem();
  if (problem) {
    process.stderr.write(`${problem}\n`);
    return EXIT_USAGE;
  }

  const project = resolveProject(args);
  const originFlag = args.str('origin');
  const origin = originFlag === undefined ? undefined : parseOrigin(originFlag);
  const source = resolveSource(args, project);
  const json = args.bool('json');

  if (args.bool('check')) {
    if (source.kind === 'url') throw new UsageError(ERRORS.checkNeedsFiles);
    return printFreshness(source, json);
  }

  // A one-off --origin on a crawl: the config's publicOrigin is what generate reads, so it is
  // overridden for this run and left alone on disk.
  const loaded =
    source.kind === 'files' ? source.loaded : origin ? { ...project, config: { ...project.config, publicOrigin: origin } } : project;
  const site = source.kind === 'url' ? source.target.origin : '';

  const tierFlag = args.str('tier');
  if (tierFlag && tierFlag !== 'free' && tierFlag !== 'ai') {
    process.stderr.write(`${ERRORS.unknownTier(tierFlag)}\n`);
    return EXIT_USAGE;
  }
  const tier = /** @type {'free' | 'ai' | undefined} */ (tierFlag) ?? loaded.config.generate.tier;

  // With --json, stdout carries the JSON document and nothing else, or `| jq` breaks.
  /** @type {((input: EnhanceInput) => Promise<EnhanceOutput>) | undefined} */
  let enhance;
  let aiLabel = '';
  if (tier === 'ai') {
    const built = buildEnhancer(args, loaded);
    if ('error' in built) {
      process.stderr.write(`\n${built.error}\n\n`);
      return built.usage ? EXIT_USAGE : 1;
    }
    enhance = built.enhance;
    aiLabel = `  ${c.gray(`AI tier, ${built.provider}/${built.model}, ${built.source}`)}`;
  }
  if (!json) {
    const what = source.kind === 'url' ? site : source.file ? join(source.folder, source.file) : `${source.folder}/`;
    process.stdout.write(`\n${c.bold('OpenGEO')} ${c.gray('generate')}  ${what}${aiLabel}\n`);
  }

  const progress = json ? undefined : createProgress();
  const progressIsLive = canRedraw();
  let lastPhase = '';
  /** @type {GenerateSiteResult} */
  let result;
  try {
    const shared = {
      loaded,
      tier,
      force: args.bool('force'),
      maxPages: args.num('max-pages'),
      skipSiteFiles: args.bool('skip-files'),
      prune: args.bool('prune'),
      enhance,
      onProgress: /** @param {import('../../generate/site.js').SiteProgress} event */ (event) => {
        if (!progress) return;
        if (event.phase === 'crawl') {
          if (lastPhase !== 'crawl') {
            progress.phase('Discovering routes by following links');
            lastPhase = 'crawl';
          }
          progress.step(event.crawl.visited + 1, event.crawl.found, event.crawl.route);
          return;
        }
        if (event.phase === 'generate') {
          if (lastPhase !== 'generate') {
            progress.phase('Converting pages');
            lastPhase = 'generate';
          }
          // Every route fires four events (fetch, extract, ai, write) and the live block can show all
          // of them, but the plain transcript prints a line per event, which is four times the noise
          // the old code made. So the counter always advances and only the AI pass, the one with a
          // real per-route cost, gets a line in the transcript.
          const detail = event.generate.phase === 'ai' ? `${event.generate.route} ${c.gray('(AI)')}` : event.generate.route;
          if (progressIsLive || event.generate.phase === 'ai') {
            progress.step(event.generate.index, event.generate.total, detail);
          }
          return;
        }
        if (event.phase === 'files') {
          progress.phase('Writing robots.txt, llms.txt and sitemap.xml');
          lastPhase = 'files';
        }
      },
    };
    result =
      source.kind === 'url'
        ? await generateSite({
            ...shared,
            target: source.target.toString(),
            single: args.bool('single'),
            maxDepth: args.num('depth'),
            timeoutMs: args.num('timeout') !== undefined ? /** @type {number} */ (args.num('timeout')) * 1000 : undefined,
          })
        : await generateFromFiles({ ...shared, file: source.file, origin, target: source.folder });
  } catch (error) {
    // Said as a usage problem: the folder is what was typed, and its message says what to type instead.
    if (error instanceof SourceFilesError) throw new UsageError(error.message);
    throw error;
  } finally {
    // Also on a throw: a spinner left running redraws over the error printed after it.
    progress?.done();
  }

  // Remembered only once the run has shown the folder holds a site, so a typo never leaves a config
  // behind it.
  /** @type {string[]} */
  const saved = [];
  if (source.kind === 'files') saved.push(...rememberFiles(source, project, origin, result));

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          site: result.site,
          durationMs: result.durationMs,
          pages: result.generate.pages,
          files: result.files,
          warnings: result.warnings,
          source: result.source,
          ...(result.scan ? { scan: result.scan } : {}),
          ...(result.notes ? { notes: [...result.notes, ...saved] } : {}),
          orphans: result.generate.orphans,
          pruned: result.generate.pruned,
          manifest: result.generate.manifest,
        },
        null,
        2,
      )}\n`,
    );
    return result.generate.pages.some((page) => page.status === 'failed') ? 1 : 0;
  }

  // Provider error bodies and page warnings are remote text, so they are cleaned before printing.
  const report = terminalSafe(result);
  process.stdout.write(`${heading('Pages')}\n`);
  // A provider that refuses on the first page gives every later page the same warning, and fifty
  // copies of one paragraph bury the pages that had something else to say.
  /** @type {Set<string>} */
  const warned = new Set();
  for (const page of report.generate.pages) {
    const label =
      page.status === 'written'
        ? c.green('written')
        : page.status === 'cached'
          ? c.gray('cached ')
          : page.status === 'skipped-manual'
            ? c.yellow('manual ')
            : page.status === 'proposed'
              ? c.yellow('kept   ')
              : c.red('failed ');
    const detail =
      page.status === 'written'
        ? c.gray(`${page.tokens} tokens  ${source.kind === 'url' ? twinUrlFor(site, page.route) : (page.file ?? '')}`)
        : c.gray(page.reason ?? '');
    process.stdout.write(`  ${label} ${(page.sourceFile ?? page.route).padEnd(24)} ${detail}\n`);
    for (const warning of page.warnings) {
      const repeat = warned.has(warning);
      warned.add(warning);
      process.stdout.write(`${hanging(`          ${c.yellow('warn')} `, repeat ? c.gray('same as above') : warning)}\n`);
    }
  }

  if (report.files.length > 0) {
    process.stdout.write(`${heading('Site files')}\n`);
    for (const file of report.files) {
      const label =
        file.status === 'written'
          ? c.green('written')
          : file.status === 'unchanged'
            ? c.gray('cached ')
            : file.status === 'proposed'
              ? c.yellow('kept   ')
              : c.red('failed ');
      const detail =
        file.status === 'proposed'
          ? c.gray(`yours left alone, proposal at ${shownPath(file.path)}`)
          : c.gray(shownPath(file.path));
      process.stdout.write(`  ${label} ${file.name.padEnd(24)} ${detail}\n`);
    }
  }

  const pages = report.generate.pages;
  const written = pages.filter((page) => page.status === 'written').length;
  const failed = pages.filter((page) => page.status === 'failed').length;
  const proposed = pages.filter((page) => page.status === 'proposed').length;
  const aiPages = pages.filter((page) => page.tier === 'ai').length;
  const fellBack = pages.filter((page) => page.warnings.some((w) => w.startsWith('Kept the algorithmic version'))).length;

  process.stdout.write(
    `\n  ${written} written, ${pages.length - written - failed - proposed} unchanged` +
      `${proposed > 0 ? `, ${c.yellow(`${proposed} kept as yours`)}` : ''}${failed > 0 ? `, ${c.red(`${failed} failed`)}` : ''}` +
      `${tier === 'ai' ? `, ${aiPages === 0 && written > 0 ? c.yellow('0 AI-enhanced') : `${aiPages} AI-enhanced`}${fellBack > 0 ? `, ${c.yellow(`${fellBack} fell back on fidelity`)}` : ''}` : ''}` +
      ` ${c.gray(`in ${report.durationMs}ms`)}\n`,
  );
  process.stdout.write(`  ${c.gray(`Output: ${shownPath(report.generate.publicDir)}`)}\n`);
  if (source.kind === 'files') process.stdout.write(`  ${c.gray(`Links name: ${report.site}`)}\n`);

  /** @param {string} file */
  const onDisk = (file) => shownPath(join(report.generate.publicDir, file));
  // Reported on every run until it is dealt with, because nothing is ever deleted without --prune.
  if (report.generate.orphans.length > 0) {
    process.stdout.write(`${heading('Orphaned twins')}\n`);
    for (const orphan of report.generate.orphans) {
      process.stdout.write(`  ${c.yellow('orphan ')} ${orphan.route.padEnd(24)} ${c.gray(onDisk(orphan.file))}\n`);
    }
    process.stdout.write(`\n${indent(wrap(ERRORS.orphansFound(report.generate.orphans.length), terminalWidth() - 2).join('\n'))}\n`);
  }
  if (report.generate.pruned.length > 0) {
    process.stdout.write(`${heading('Pruned')}\n`);
    for (const orphan of report.generate.pruned) {
      process.stdout.write(`  ${c.gray('deleted')} ${orphan.route.padEnd(24)} ${c.gray(onDisk(orphan.file))}\n`);
    }
  }

  const crawlWarnings = report.warnings.filter((w) => !w.includes('.opengeo-proposed'));
  const notes = [...(report.notes ?? []), ...saved];
  const skipped = report.scan?.skipped ?? [];
  if (crawlWarnings.length + notes.length + skipped.length > 0) {
    process.stdout.write(`${heading('Notes')}\n`);
    for (const warning of crawlWarnings) process.stdout.write(`${hanging(`  ${c.yellow('warn')} `, warning)}\n`);
    for (const note of notes) process.stdout.write(`${hanging(`  ${c.gray('note')} `, note)}\n`);
    for (const line of skipped) process.stdout.write(`${hanging(`  ${c.gray('skip')} `, line)}\n`);
  }
  for (const file of report.files) {
    if (file.status === 'proposed' && file.message) {
      process.stdout.write(`\n${indent(file.message)}\n`);
    }
  }
  // A single page is regenerated because it changed, and the person who edited it has usually
  // edited others too. One line, and only when there is something to say.
  if (source.kind === 'files' && source.file) {
    const fresh = checkFreshness(loaded);
    const behind = fresh?.stale.length ?? 0;
    if (behind > 0) {
      process.stdout.write(`\n  ${c.yellow(`${behind} other ${behind === 1 ? 'page is' : 'pages are'} out of date.`)} ${c.gray(`\`${source.command} --check\` lists ${behind === 1 ? 'it' : 'them'}.`)}\n`);
    }
  }
  process.stdout.write('\n');
  return failed > 0 ? 1 : 0;
}

/**
 * Prefixes the first line and indents the rest under it, so a long note wraps under its own text.
 *
 * @param {string} prefix
 * @param {string} text
 * @returns {string}
 */
function hanging(prefix, text) {
  const width = visibleWidth(prefix);
  const lines = wrap(text, Math.max(20, terminalWidth() - width - 1));
  return lines.map((line, i) => (i === 0 ? `${prefix}${line}` : `${' '.repeat(width)}${line}`)).join('\n');
}

/**
 * Turns the positional argument into a URL to crawl, a folder to read, or one page in that folder.
 *
 * A folder wins over a URL only when it exists, and a URL is only something with a scheme, so a
 * bare `example.com` is never mistaken for either: it gets a message that suggests both.
 *
 * @param {Args} args
 * @param {LoadedConfig} loaded
 * @returns {Source}
 */
function resolveSource(args, loaded) {
  const raw = args.positionals[0];
  const configured = loaded.exists && loaded.config.generate.source === 'files';

  if (raw === undefined) {
    if (!configured) return { kind: 'url', target: resolveTarget(args, loaded, 'generate') };
    const folder = shownPath(publicDirPath(loaded));
    if (args.bool('single')) throw new UsageError(ERRORS.filesSingleNeedsPage(folder));
    return { kind: 'files', loaded, folder, command: 'opengeo generate', create: false, tip: false };
  }
  if (/^https?:\/\//i.test(raw)) return { kind: 'url', target: resolveTarget(args, loaded, 'generate') };

  const path = resolve(process.cwd(), raw);
  const stats = statOrUndefined(path);
  if (!stats) throw new UsageError(ERRORS.notUrlOrFolder(raw));

  if (stats.isFile()) {
    if (!isHtmlFile(path)) throw new UsageError(ERRORS.notAPageFile(raw));
    if (!configured) throw new UsageError(ERRORS.filesSingleNeedsSite(raw));
    const webRoot = publicDirPath(loaded);
    const folder = shownPath(webRoot);
    const inside = relative(webRoot, path);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new UsageError(ERRORS.htmlFileOutsideWebRoot(raw, folder));
    return { kind: 'files', loaded, file: inside.split(sep).join('/'), folder, command: 'opengeo generate', create: false, tip: false };
  }
  if (!stats.isDirectory()) throw new UsageError(ERRORS.notUrlOrFolder(raw));

  const folder = shownPath(path);
  if (args.bool('single')) throw new UsageError(ERRORS.filesSingleNeedsPage(folder));
  const inProject = relative(loaded.root, path);
  if (inProject === '') throw new UsageError(ERRORS.filesAtProjectRoot(raw, basename(path)));
  if (inProject.startsWith('..') || isAbsolute(inProject)) throw new UsageError(ERRORS.filesOutsideProject(raw, loaded.root));

  const publicDir = inProject.split(sep).join('/');
  if (loaded.exists) {
    if (publicDirPath(loaded) !== path) throw new UsageError(ERRORS.filesWebRootMismatch(folder, shownPath(publicDirPath(loaded))));
    const command = configured ? 'opengeo generate' : `opengeo generate ${folder}`;
    return { kind: 'files', loaded, folder, command, create: false, tip: !configured };
  }
  // No config yet: this run is how the project gets one. The folder is the web root, and the
  // config only reaches disk once the run has found pages in it.
  const config = mergeConfig(loaded.config, { publicDir, generate: { source: 'files' } });
  return { kind: 'files', loaded: { ...loaded, config }, folder, command: 'opengeo generate', create: true, tip: false };
}

/**
 * The config changes a run from a folder earns, written after the run and reported as notes.
 *
 * @param {Extract<Source, { kind: 'files' }>} source
 * @param {LoadedConfig} project The project as it was loaded, before this run changed anything.
 * @param {string | undefined} origin From --origin.
 * @param {GenerateSiteResult} result
 * @returns {string[]}
 */
function rememberFiles(source, project, origin, result) {
  const wrote = result.generate.pages.some((page) => page.status !== 'failed');
  if (!wrote) return [];
  /** @type {string[]} */
  const notes = [];
  if (source.create) {
    // `site` is what `opengeo test` checks when it is given no URL, and for a folder of files the
    // published site is the only one there is.
    const known = origin && !isLoopbackUrl(origin) ? { site: origin, publicOrigin: origin } : {};
    const path = saveConfig(project.root, mergeConfig(source.loaded.config, known));
    notes.push(ERRORS.filesConfigCreated(shownPath(path)));
    return notes;
  }
  if (origin) {
    const configured = project.config.publicOrigin;
    if (!configured) {
      saveConfig(project.root, mergeConfig(project.config, { publicOrigin: origin }));
      notes.push(ERRORS.filesOriginSaved(origin));
    } else if (new URL(configured).origin !== origin) {
      notes.push(ERRORS.originDiffersFromConfig(origin, configured));
    }
  }
  if (source.tip) notes.push(ERRORS.filesSourceTip);
  return notes;
}

/**
 * `--origin`: an origin and nothing after it, with `https://` assumed for a bare domain.
 *
 * @param {string} value
 * @returns {string}
 */
function parseOrigin(value) {
  const trimmed = value.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (!URL.canParse(withScheme)) throw new UsageError(ERRORS.badOrigin(value));
  const url = new URL(withScheme);
  const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !bare || !url.hostname.includes('.') && !isLoopbackUrl(url.toString())) {
    throw new UsageError(ERRORS.badOrigin(value));
  }
  return url.origin;
}

/**
 * `--check`: which twins are older than their page. Writes nothing, and exits 1 when any are, so a
 * pre-commit hook or a deploy script can stop on it.
 *
 * @param {Extract<Source, { kind: 'files' }>} source
 * @param {boolean} json
 * @returns {number}
 */
function printFreshness(source, json) {
  if (source.create) throw new UsageError(ERRORS.checkBeforeGenerate(source.folder));
  const report = checkFreshness(source.loaded);
  if (json) {
    process.stdout.write(`${JSON.stringify(report ?? { checked: 0, stale: [] }, null, 2)}\n`);
    return report && report.stale.length === 0 ? 0 : 1;
  }
  if (!report) {
    process.stdout.write(`\n  ${ERRORS.checkBeforeGenerate(source.folder)}\n\n`);
    return 1;
  }
  const safe = terminalSafe(report);
  process.stdout.write(`\n${c.bold('OpenGEO')} ${c.gray('generate --check')}  ${source.folder}/\n`);
  if (safe.stale.length === 0) {
    process.stdout.write(`\n  ${c.green('up to date')} ${c.gray(`All ${safe.checked} ${safe.checked === 1 ? 'twin matches its page' : 'twins match their pages'}.`)}\n\n`);
    return 0;
  }
  const labels = { changed: c.yellow('changed'), manual: c.yellow('yours  '), missing: c.red('gone   '), new: c.yellow('new    ') };
  process.stdout.write(`${heading('Out of date')}\n`);
  for (const twin of safe.stale) process.stdout.write(`${hanging(`  ${labels[twin.kind]} `, twin.message)}\n`);
  const counts = staleCounts(report);
  process.stdout.write(`\n${indent(wrap(ERRORS.staleRemedy(counts, source.command), terminalWidth() - 2).join('\n'))}\n\n`);
  return 1;
}

/**
 * @param {string} path
 * @returns {import('node:fs').Stats | undefined}
 */
function statOrUndefined(path) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function indent(text) {
  return text
    .split('\n')
    .map((line) => (line ? `  ${line}` : line))
    .join('\n');
}

/**
 * @typedef {object} EnhancerReady
 * @property {(input: EnhanceInput) => Promise<EnhanceOutput>} enhance
 * @property {AiProvider} provider
 * @property {string} model
 * @property {string} source
 */

/**
 * Resolve the key and build the AI enhancer, or produce the exact §13 message explaining what is
 * missing. The key is read from the project's own `.env` and never printed, only its origin is.
 *
 * @param {ReturnType<typeof parseArgs>} args
 * @param {ReturnType<typeof resolveProject>} loaded
 * @returns {EnhancerReady | { error: string; usage?: boolean }}
 */
function buildEnhancer(args, loaded) {
  if (isCI()) return { error: ERRORS.ciBlocked("generate's AI tier") };

  const resolved = resolveAiCall(loaded.root, loaded.config, { provider: args.str('provider'), model: args.str('model') });
  if ('error' in resolved) return resolved;
  if ('missing' in resolved) return { error: ERRORS.noApiKey("generate's AI tier", resolved.lookalikes) };
  const { provider, model, apiKey, overrides, keySource } = resolved.call;

  try {
    const enhance = createAiEnhancer({ provider, model, apiKey, overrides });
    return {
      enhance,
      provider,
      model,
      source: keySource ? `key from ${keySource === 'env-file' ? '.env' : 'environment'}` : 'no key needed',
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
