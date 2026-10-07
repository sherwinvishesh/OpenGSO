import { resolveBots } from '../shared/bots.js';
import { internalDirPath, loadConfig } from '../shared/config.js';
import { ERRORS } from '../shared/errors.js';
import { readHistory } from '../test/index.js';
import { ok, bad } from './api-shared.js';
import { readState, saveConfigPatch, saveKey } from './api-settings.js';
import { runPreview, runTest, runProdTest } from './api-test.js';
import { runGenerate } from './api-generate.js';
import { readFileRoute } from './api-files.js';

/**
 * Defined in `api-types.js` with every other shape the dashboard reads, and re-exported here.
 *
 * @typedef {import('../shared/api-types.js').ApiProgress} ApiProgress
 * @typedef {import('../shared/api-types.js').StructurePayload} StructurePayload
 * @typedef {import('../shared/api-types.js').StateResponse} StateResponse
 * @typedef {import('../shared/api-types.js').PreviewResponse} PreviewResponse
 * @typedef {import('./api-shared.js').ApiRequest} ApiRequest
 * @typedef {import('./api-shared.js').ApiResponse} ApiResponse
 * @typedef {import('./api-shared.js').ApiOptions} ApiOptions
 */

/**
 * The local JSON API behind `opengeo start` (§8).
 *
 * Every endpoint is a thin wrapper over the exact function the CLI calls. That is the whole design
 * constraint: the dashboard must never become a second implementation of the pipeline, because two
 * implementations means two sets of bugs and only one of them gets tested.
 *
 * Nothing here reaches the network except the calls the user explicitly triggered, and the API key
 * is never included in a response. `GET /api/state` reports that a key exists, which provider it
 * belongs to and which file it came from - never the value.
 */

// Each route lives in its own module; these are re-exported because `server/index.js` re-exports
// this file and the tests reach them through it.
export { generateFrame } from './api-generate.js';
export { readGeneratedFile } from './api-files.js';
export { testFrame } from './api-test.js';

/** @typedef {Record<string, 'string' | 'boolean' | 'number'>} BodyFields */

/** @type {BodyFields} */
const TEST_FIELDS = { url: 'string', mode: 'string', quality: 'boolean', maxDocs: 'number', timeoutMs: 'number' };
/** @type {BodyFields} */
const GENERATE_FIELDS = {
  url: 'string',
  tier: 'string',
  single: 'boolean',
  force: 'boolean',
  skipSiteFiles: 'boolean',
  maxPages: 'number',
  maxDepth: 'number',
};

/**
 * The fields each handler below reads from its body, and what each has to be.
 *
 * The handlers cast the body to these shapes, and a cast checks nothing: `{ "path": 5 }` was a
 * TypeError and a 500, and a `maxPages` of `"lots"` was a crawl with no cap, because every
 * comparison against it is false. `null` counts as absent, as the handlers' `??` always treated it.
 * `/api/config` is not here: `configPatchProblem` checks that one field by field.
 *
 * @type {Record<string, BodyFields>}
 */
const BODY_FIELDS = {
  'POST /api/preview': { url: 'string' },
  'POST /api/test': TEST_FIELDS,
  'POST /api/test/stream': TEST_FIELDS,
  'POST /api/generate': GENERATE_FIELDS,
  'POST /api/generate/stream': GENERATE_FIELDS,
  'POST /api/prod-test': { url: 'string', bot: 'string', timeoutMs: 'number' },
  'POST /api/key': { provider: 'string', apiKey: 'string', model: 'string', baseUrl: 'string', api: 'string', auth: 'string' },
  'POST /api/file': { path: 'string' },
};

/**
 * @param {unknown} body
 * @param {BodyFields} fields
 * @returns {string | undefined}
 */
function bodyProblem(body, fields) {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'object' || Array.isArray(body)) return ERRORS.requestNotObject();
  for (const [field, expected] of Object.entries(fields)) {
    const value = /** @type {Record<string, unknown>} */ (body)[field];
    if (value !== undefined && value !== null && typeof value !== expected) return ERRORS.requestFieldType(field, expected, value);
  }
  return undefined;
}

/**
 * @param {ApiRequest} request
 * @param {ApiOptions} options
 * @returns {Promise<ApiResponse>}
 */
export async function handleApi(request, options) {
  const { method, path } = request;
  const route = `${method} ${path}`;
  const fields = BODY_FIELDS[route];
  if (fields) {
    const problem = bodyProblem(request.body, fields);
    if (problem) return bad(problem);
  }

  switch (route) {
    case 'GET /api/state':
      return ok(readState(options));
    case 'GET /api/history':
      // Capped by the writer at 20 runs per URL and 200 overall, so there is no pagination to design here.
      return ok(readHistory(internalDirPath(loadConfig(options.root))));
    case 'GET /api/bots':
      // The resolved list, so the dashboard's crawler table shows a project's own agents beside
      // the shipped ones instead of quietly leaving them out of a list that looks complete.
      return ok({ bots: resolveBots(loadConfig(options.root).config.bots.custom) });
    case 'POST /api/config':
      return saveConfigPatch(request.body, options);
    case 'POST /api/preview':
      return await runPreview(request.body);
    // Each of these two answers on two paths. The handler is identical; `/stream` only tells the
    // transport to hold the response open and forward `options.onProgress` as it arrives, so a
    // script that wants one JSON object and a browser that wants narration run the same code.
    case 'POST /api/test':
    case 'POST /api/test/stream':
      return await exclusive('test', options.root, () => runTest(request.body, options));
    case 'POST /api/generate':
    case 'POST /api/generate/stream':
      return await exclusive('generate', options.root, () => runGenerate(request.body, options));
    case 'POST /api/prod-test':
      return await runProdTest(request.body, options);
    case 'POST /api/key':
      return saveKey(request.body, options);
    case 'POST /api/file':
      return readFileRoute(request.body, options);
    default:
      return { status: 404, body: { error: ERRORS.noSuchEndpoint(route) } };
  }
}

/** The runs in flight, as `kind:root`. */
const running = new Set();

/**
 * One run of each kind per project at a time.
 *
 * Two generates would race each other for the manifest, and two tests pay for the same content
 * review twice. A second tab, or a double click before the button disables, used to start both.
 *
 * @param {'test' | 'generate'} kind
 * @param {string} root
 * @param {() => Promise<ApiResponse>} run
 * @returns {Promise<ApiResponse>}
 */
async function exclusive(kind, root, run) {
  const key = `${kind}:${root}`;
  if (running.has(key)) return { status: 409, body: { error: ERRORS.runInProgress(kind) } };
  running.add(key);
  try {
    return await run();
  } finally {
    running.delete(key);
  }
}
