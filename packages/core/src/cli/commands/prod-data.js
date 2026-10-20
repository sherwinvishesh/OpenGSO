import { isAbsolute, relative } from 'node:path';
import { EDGE_DATA_WARN_BYTES, writeEdgeData } from '../../prod/edge-data.js';
import { PROD_ERRORS } from '../../shared/errors.js';
import { shownPath } from '../../shared/local-pages.js';
import { c, cErr } from '../../shared/log.js';
import { EXIT_USAGE, parseArgs } from '../args.js';
import { resolveProject } from '../project.js';

/** @import { CommandContext } from '../index.js' */

const SPEC = /** @type {const} */ ({
  booleans: ['json', 'force'],
  strings: ['project', 'out'],
});

/**
 * `omnigeo prod data`: the twins as a module an edge function imports.
 *
 * An edge runtime has no disk, so the Node adapters' way of loading twins does not exist there.
 * This reads them the way those adapters do and writes the result as data, to be run after
 * `generate` and before the bundler, usually as the first step of the build script.
 *
 * @param {CommandContext} ctx
 * @returns {Promise<number>}
 */
export async function prodDataCommand(ctx) {
  const args = parseArgs(ctx.argv, SPEC);
  const problem = args.problem();
  if (problem) {
    process.stderr.write(`${problem}\n`);
    return EXIT_USAGE;
  }
  if (args.positionals.length > 0) {
    process.stderr.write(`${PROD_ERRORS.edgeDataTakesNoUrl(args.positionals[0])}\n`);
    return EXIT_USAGE;
  }

  const loaded = resolveProject(args);
  const result = writeEdgeData({ loaded, out: args.str('out') || undefined, force: args.bool('force') });
  if (result.pages === 0) {
    // Nothing was bundled because nothing could be read. The module on disk, if any, is left as it
    // was: replacing a working one with an empty one would quietly turn the edge's markdown off.
    if (args.bool('json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stderr.write(`${cErr.red('Error')} ${PROD_ERRORS.edgeDataEmpty(result.problems)}\n`);
    return 1;
  }

  if (args.bool('json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.proposed ? 1 : 0;
  }

  const size = sizeOf(result.bytes);
  const twins = `${result.pages} twin${result.pages === 1 ? '' : 's'}, ${size}`;
  const lines = [''];
  if (result.proposed) {
    lines.push(`${c.yellow('Proposed')} ${shownPath(result.path)}  ${c.gray(twins)}`, '', PROD_ERRORS.edgeDataProposed(shownPath(result.target), shownPath(result.path)));
  } else {
    lines.push(`${result.unchanged ? c.gray('Unchanged') : c.green('Wrote')} ${shownPath(result.path)}  ${c.gray(twins)}`);
  }
  for (const problem of result.problems) lines.push(`  ${c.yellow('!')} ${problem}`);
  if (result.bytes > EDGE_DATA_WARN_BYTES) lines.push('', c.yellow(PROD_ERRORS.edgeDataLarge(size)));
  if (!result.proposed) {
    const fromRoot = relative(loaded.root, result.target).replace(/\\/g, '/').replace(/\.(m|c)?[jt]s$/, '');
    const from = fromRoot.startsWith('../') || isAbsolute(fromRoot) ? fromRoot : `./${fromRoot}`;
    lines.push(
      '',
      c.gray('Use it in your edge function (the import path is from the project root):'),
      `  import data from '${from}';`,
      `  import { createEdgeMiddleware } from '${result.importFrom}';`,
      `  const omnigeo = createEdgeMiddleware({ data });`,
      '',
      c.gray('Run it again after every `omnigeo generate`, or first in your build script, so the edge never serves old twins.'),
    );
  }
  lines.push('');
  process.stdout.write(lines.join('\n'));
  return result.proposed ? 1 : 0;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function sizeOf(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
