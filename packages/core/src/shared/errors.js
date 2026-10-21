/**
 * Every user-facing error string in OpenGSO lives here (§13).
 *
 * One shared module, imported by all five published packages, so wording only ever changes in one
 * place and a limited install can tell the user exactly which package to reach for instead.
 */

import { AI_PROVIDERS, providerInfo, suggestProvider } from './providers.js';

/** @import { AiProvider } from './providers.js' */

/**
 * The errors config loading can raise, kept apart from `ERRORS` because `opengso-prod` loads the
 * config on every boot and `ERRORS` reaches into the provider catalogue. Nothing in here may
 * reference a provider, or prod's bundle grows AI code and `check:bundles` fails the build.
 */
export const CONFIG_ERRORS = /* @__PURE__ */ Object.freeze({
  /**
   * Search-index crawlers on the routing list. Read by `opengso settings` and by prod at boot, which
   * is the one place a project configured before this warning existed will see it.
   *
   * @param {readonly string[]} names
   */
  searchCrawlersRouted: (names) => {
    const one = names.length === 1;
    const them = one ? 'it' : 'them';
    const they = one ? 'it' : 'they';
    const listed = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return (
      `bots.markdownRouting sends markdown to ${listed}, which ${one ? 'builds a search index' : 'build search indexes'}. ` +
      `Every markdown response carries X-Robots-Tag: noindex, and at the page's own URL that tells ${them} to drop the page from search results. ` +
      `Take ${them} off the list unless that is what you want; ${they} can still ask for markdown with an Accept header.`
    );
  },

  /**
   * A key in opengso.config.json that nothing reads. Loading carries on, since a newer version may
   * have written it; this is so a misspelt one is not silently replaced by its default. Here rather
   * than in ERRORS because prod says it at boot too.
   *
   * @param {string} key
   * @param {string} [suggestion]
   */
  unknownConfigKey: (key, suggestion) =>
    suggestion
      ? `opengso.config.json has "${key}", which OpenGSO does not read, so its default is used. Did you mean "${suggestion}"?`
      : `opengso.config.json has "${key}", which OpenGSO does not read. Every field it reads is in docs/config.md.`,

  /**
   * @param {string} field
   * @param {unknown} value
   * @param {string} root
   */
  dirOutsideProject: (field, value, root) =>
    [
      `${field} in opengso.config.json is ${JSON.stringify(value)}, which is not a directory inside the project.`,
      ``,
      `It has to be a relative path to a folder below ${root}, such as "public". The project root`,
      `itself is refused too: it holds .env, and anything OpenGSO can read or write there is too much.`,
    ].join('\n'),

  /**
   * @param {string} field
   * @param {string} expected
   * @param {unknown} value
   */
  badField: (field, expected, value) =>
    `${field} in opengso.config.json has to be ${expected}, and it is ${JSON.stringify(value) ?? String(value)}.`,

  /**
   * @param {string} path
   * @param {string} reason
   */
  unreadable: (path, reason) =>
    [
      `${path} could not be read: ${reason}`,
      ``,
      `Fix the file by hand, or delete it and run \`opengso settings\` to write a fresh one.`,
    ].join('\n'),

  /**
   * The one line opengso-prod logs at boot instead of crashing the site. One line, because it lands
   * in a hosting platform's deploy log next to everything else.
   *
   * @param {string} problem A message from one of the entries above.
   */
  prodFailedOpen: (problem) =>
    `[opengso-prod] markdown is off, and every request passes through to the normal site, until opengso.config.json is fixed: ${problem.split('\n')[0]}`,
});

/**
 * Problems prod's twin store reports at boot. Same rule as `CONFIG_ERRORS`: this ships inside
 * opengso-prod, so nothing in here may reference a provider.
 */
export const STORE_ERRORS = /* @__PURE__ */ Object.freeze({
  /**
   * @param {string} route
   * @param {string} file The manifest's `file` value, as written.
   * @param {string} publicDir
   */
  twinOutsidePublicDir: (route, file, publicDir) =>
    `Manifest lists ${route} at ${file}, which resolves outside ${publicDir}, so it was not loaded. ` +
    'OpenGSO only ever writes twins inside publicDir: rerun `opengso generate` to rewrite the manifest.',

  /** @param {string} manifestFile */
  manifestHasNoPages: (manifestFile) =>
    `${manifestFile} is JSON but has no page table, so no twins were loaded. Rerun \`opengso generate\` to rewrite it.`,

  /**
   * @param {string} key The entry's key in the page table.
   * @param {string} manifestFile
   */
  manifestEntryUnusable: (key, manifestFile) =>
    `${manifestFile} lists ${key} without a route and a file, so it was not loaded. Rerun \`opengso generate\` to rewrite the manifest.`,

  /** @param {string} manifestFile */
  noManifest: (manifestFile) =>
    `No manifest at ${manifestFile}. Run \`opengso generate <url>\` to create the markdown twins.`,

  /**
   * @param {string} manifestFile
   * @param {string} reason
   */
  unreadableManifest: (manifestFile, reason) =>
    `Could not read ${manifestFile}: ${reason}. Rerun \`opengso generate\` to rewrite it.`,

  /**
   * @param {string} route
   * @param {string} file Absolute path of the twin that is not there.
   */
  twinMissing: (route, file) => `Manifest lists ${route} but ${file} is missing. Rerun \`opengso generate\`.`,

  /**
   * @param {string} route
   * @param {string} file Absolute path of the twin.
   * @param {string} reason
   */
  twinUnreadable: (route, file, reason) =>
    `Manifest lists ${route} but ${file} could not be read: ${reason}. Rerun \`opengso generate\`.`,

  /**
   * The edge store's version of `twinMissing`: the caller built the data module and left this one out.
   *
   * @param {string} route
   * @param {string} file The manifest's `file` value.
   */
  contentNotSupplied: (route, file) =>
    `Manifest lists ${route} but no content was supplied for ${file}. Regenerate the data module after \`opengso generate\`.`,

  /**
   * Logged when a development server notices the twins changed on disk and the new ones cannot be
   * loaded. The previous twins keep being served, so the line says that rather than sounding fatal.
   *
   * @param {string} reason
   */
  reloadFailed: (reason) =>
    `[opengso-prod] the files changed on disk but could not be reloaded, so the previous twins are still being served: ${reason.split('\n')[0]}`,
});

/**
 * What prod's adapters log while serving. One line each, for the same reason as `prodFailedOpen`:
 * it lands in a hosting platform's log beside everything else.
 */
export const PROD_ERRORS = /* @__PURE__ */ Object.freeze({
  /**
   * A request prod could not decide goes to the site as if prod were not installed. Logged for the
   * first one only, so a malformed request repeated by a scanner cannot fill the log.
   *
   * @param {string} reason
   */
  requestFailedOpen: (reason) =>
    `[opengso-prod] a request could not be checked for a markdown twin, so it went to the normal site (later ones are not logged): ${reason.split('\n')[0]}`,

  /**
   * `opengso prod data` with nothing to bundle. Nothing is written: an edge function built from an
   * empty module would deploy fine and serve no markdown, which is the failure nobody notices.
   *
   * @param {string[]} problems
   */
  edgeDataEmpty: (problems) =>
    [
      `No twins to bundle for the edge, so nothing was written.`,
      ``,
      ...problems.slice(0, 5).map((problem) => `  ${problem}`),
      ...(problems.length > 5 ? [`  ...and ${problems.length - 5} more`] : []),
      // Every problem that leads here already says to run generate, so it is said once.
      ...(problems.length > 0 ? [] : [`Run \`opengso generate <url>\` first, then this again.`]),
    ].join('\n'),

  /**
   * @param {string} target
   * @param {string} proposed
   */
  edgeDataProposed: (target, proposed) =>
    [
      `${target} already exists and OpenGSO did not write it, so it was left alone.`,
      `The edge data went to ${proposed} instead. Point --out somewhere else, or use --force to replace it.`,
    ].join('\n'),

  /** @param {string} size */
  edgeDataLarge: (size) =>
    `The edge data is ${size}. Some edge hosts cap a function at about 1 MB compressed, so check your host's limit before deploying.`,

  /**
   * @param {string} file
   * @param {number} pages
   */
  edgeDataRefreshed: (file, pages) =>
    `Refreshed ${file} with ${pages} twin${pages === 1 ? '' : 's'}, so the edge serves this run's markdown once it is deployed.`,

  /**
   * @param {string} file
   * @param {string} reason
   */
  edgeDataRefreshFailed: (file, reason) =>
    `Could not refresh ${file}, so the edge still has the twins from before: ${reason.split('\n')[0]}. Run \`opengso prod data\` to retry.`,

  /** @param {string} arg */
  edgeDataTakesNoUrl: (arg) =>
    `\`opengso prod data\` reads the twins on disk and takes no URL (got ${arg}). Run \`opengso generate ${arg}\` first if they are not there yet.`,
});

/** @typedef {'test' | 'generate' | 'settings' | 'start' | 'prod test' | 'prod data'} CommandName */

/**
 * Which published packages actually ship each command (§10).
 *
 * @type {Record<CommandName, string[]>}
 */
export const COMMAND_PACKAGES = {
  test: ['opengso', 'opengso-cli', 'opengso-testing'],
  generate: ['opengso', 'opengso-cli', 'opengso-generate'],
  settings: ['opengso', 'opengso-cli'],
  start: ['opengso'],
  'prod test': ['opengso', 'opengso-cli', 'opengso-prod'],
  'prod data': ['opengso', 'opengso-cli', 'opengso-prod'],
};

/** @type {Record<CommandName, string>} */
export const COMMAND_BLURB = {
  test: 'scores a live URL 0-100 for AI-readiness',
  generate: 'writes the .md twins, robots.txt, llms.txt and sitemap.xml',
  settings: 'changes the site, the bot lists and the API key, in your terminal',
  start: 'sets the project up, then opens the OpenGSO dashboard',
  'prod test': 'verifies a deployed opengso-prod middleware is serving correctly',
  'prod data': 'bundles the twins into a module for edge functions, which have no disk',
};

/**
 * The narrowest package that ships a given command, for the "install just this" suggestion.
 *
 * @type {Record<CommandName, string>}
 */
export const NARROWEST_PACKAGE = {
  test: 'opengso-testing',
  generate: 'opengso-generate',
  settings: 'opengso-cli',
  start: 'opengso',
  'prod test': 'opengso-prod',
  'prod data': 'opengso-prod',
};

/**
 * Three of the five commands are pillars (§2). `settings` and `start` are not, and calling
 * them one would make the error read as if written by someone who had never run the tool.
 *
 * @type {Partial<Record<CommandName, string>>}
 */
const PILLAR_OF = {
  test: 'test',
  generate: 'generate',
  'prod test': 'prod',
  'prod data': 'prod',
};

/**
 * Shown when a limited install is asked for a command it doesn't include - e.g. someone installed
 * only `opengso-testing` and ran `opengso generate`.
 *
 * The suggestions are derived rather than written out, because two of the five commands make the
 * hand-written version wrong: `opengso-cli` does not ship `start`, and it is itself the narrowest
 * package that ships `settings`. Both cases used to recommend a package that would not have helped.
 *
 * @param {CommandName} command
 * @param {string} installedPackage
 * @returns {string}
 */
export function commandUnavailable(command, installedPackage) {
  const narrowest = NARROWEST_PACKAGE[command];
  const pillar = PILLAR_OF[command];
  const ways =
    narrowest === 'opengso'
      ? [`The fix:`, `  npm install -D opengso`]
      : [
          `Two ways forward:`,
          `  just this one thing   npm install -D ${narrowest}`,
          `  all of OpenGSO        npm install -D opengso`,
        ];
  return [
    `\`opengso ${command}\` isn't part of ${installedPackage}.`,
    ``,
    `You have ${installedPackage} installed, which doesn't include the ${pillar ? `${pillar} pillar` : `${command} command`}.`,
    `\`opengso ${command}\` ${COMMAND_BLURB[command]}.`,
    ``,
    ...ways,
    ``,
    `Packages that ship \`opengso ${command}\`: ${COMMAND_PACKAGES[command].join(', ')}.`,
  ].join('\n');
}

/**
 * @param {string} command
 * @param {CommandName[]} available
 * @returns {string}
 */
export function unknownCommand(command, available) {
  // `prod` is the only word that starts a command without being one, so its commands get named
  // outright rather than left for the reader to find in the list below.
  const prod =
    command.split(' ')[0] === 'prod'
      ? [`\`opengso prod\` has two commands under it: opengso prod test <url>, and opengso prod data`]
      : [];
  return [
    `Unknown command: \`opengso ${command}\`.`,
    ...prod,
    ``,
    available.length > 0
      ? `This install can run: ${available.map((c) => `opengso ${c}`).join(', ')}.`
      : `This install ships no CLI commands.`,
    `Run \`opengso --help\` for the full list.`,
  ].join('\n');
}

/**
 * Only the host of a redirect target. Its path and query are the remote server's words, not ours.
 *
 * @param {string} location
 * @returns {string}
 */
function redirectHost(location) {
  try {
    return new URL(location).host || 'another address';
  } catch {
    return 'another address';
  }
}

/**
 * What a provider's status code usually means, for the person who has to fix it. The body the
 * provider sent is printed above it and is the authority; this line says where to look first.
 *
 * @param {number} status
 * @param {string} [model] Named because the usual cause of a 400 or a 404 is a typo in it.
 * @returns {string | undefined}
 */
function statusHint(status, model) {
  const asked = model ? ` (this run asked for "${model}")` : '';
  if (status === 400 || status === 422) return `  The provider refused the request itself: usually a model id it does not offer${asked}, or a field in ai.params it does not accept.`;
  if (status === 401 || status === 403) return '  The key was refused. Check it is a key for this provider, that it is still active, and that the account has credit.';
  if (status === 402) return '  The account is out of credit. Top it up with the provider and run this again.';
  if (status === 404) return `  Nothing at that address: usually a model id the provider does not offer${asked}, or an ai.baseUrl or ai.api that is wrong. \`opengso help providers\` lists each provider's default model.`;
  if (status === 429) return '  Rate limited, or out of quota for now. Waiting a minute and running it again usually works.';
  if (status >= 500) return '  The provider had a problem on its side. Running it again in a few minutes usually works.';
  return undefined;
}

/**
 * What to fix after a status that stopped a run (see `failsEveryCall`), in one sentence.
 *
 * @param {number} status
 * @param {string} rerun What to do once it is fixed, e.g. "run generate again".
 * @returns {string}
 */
function stopCause(status, rerun) {
  if (status === 402) return `The account is out of credit: top it up with the provider and ${rerun}.`;
  if (status === 404) return `That model, or that address, does not exist at this provider: check the model id (and ai.baseUrl if you set one) and ${rerun}. \`opengso help providers\` lists each provider's default model.`;
  return `That is almost always the API key or the account it belongs to: check it with \`opengso settings\` and ${rerun}.`;
}

/**
 * `.env` lines that hold a key under a name OpenGSO does not read, each with the name to use.
 * Named, never used: guessing which line is a key is how one ends up sent somewhere it was not
 * meant for.
 *
 * @param {readonly { name: string; provider: string }[]} lookalikes
 * @returns {string[]}
 */
function lookalikeLines(lookalikes) {
  return lookalikes.slice(0, 3).flatMap(({ name, provider }) => {
    const info = providerInfo(/** @type {import('./providers.js').AiProvider} */ (provider));
    return [
      ``,
      `.env has ${name}, which looks like ${/^[aeiou]/i.test(info.label) ? 'an' : 'a'} ${info.label} key, but OpenGSO only reads`,
      `the names providers document, so it was not used. Rename that line to:`,
      `  ${info.envVars[0]}=<the same key>`,
    ];
  });
}

/**
 * Wrap a comma-separated list at `width` so a long catalogue does not run off a terminal.
 *
 * @param {readonly string[]} items
 * @param {number} width
 * @returns {string[]}
 */
function wrapList(items, width) {
  /** @type {string[]} */
  const lines = [];
  let current = '';
  items.forEach((item, index) => {
    const piece = index === items.length - 1 ? item : `${item}, `;
    if (current && current.length + piece.length > width) {
      lines.push(current.trimEnd());
      current = '';
    }
    current += piece;
  });
  if (current) lines.push(current.trimEnd());
  return lines;
}

export const ERRORS = /* @__PURE__ */ Object.freeze({
  /** @param {string} command */
  missingUrl: (command) =>
    command === 'generate'
      ? [
          `\`opengso generate\` needs a URL or a folder.`,
          ``,
          `Give it the address of a running site to crawl it, or the folder your HTML files are in to`,
          `read them straight off disk:`,
          ``,
          `  opengso generate http://localhost:3000`,
          `  opengso generate https://your-site.com`,
          `  opengso generate site`,
        ].join('\n')
      : [
          `\`opengso ${command}\` needs a URL.`,
          ``,
          `OpenGSO always works against a URL, never a source directory - it has to see what your site`,
          `actually serves over HTTP: real headers, real response, real rendering result.`,
          ``,
          `  opengso ${command} http://localhost:3000`,
          `  opengso ${command} https://your-site.com`,
        ].join('\n'),

  /**
   * A generate argument that is neither a URL nor anything on disk.
   *
   * @param {string} value
   */
  notUrlOrFolder: (value) => {
    const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/.*)?$/i.test(value);
    const domainish = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(value);
    return [
      `"${value}" is not a URL, and there is no folder or .html file by that name here.`,
      ``,
      local
        ? `If it is your dev server, add the scheme: opengso generate http://${value}`
        : domainish
          ? `If it is a site, add the scheme: opengso generate https://${value}`
          : `A site's address needs the scheme, e.g. https://your-site.com.`,
      `If it is your site's folder, check the path: it is read from ${process.cwd()}.`,
    ].join('\n');
  },

  /** @param {string} value */
  notAPageFile: (value) =>
    `${value} is a file, but not an .html page. Give generate the folder your site's pages are in, one .html page inside it, or a URL.`,

  /** @param {string} value */
  invalidUrl: (value) =>
    `"${value}" isn't a URL OpenGSO can fetch. Include the scheme, e.g. http://localhost:3000 or https://your-site.com.`,

  /** The same refusal, inline under a field that is still waiting for an answer. */
  urlNeedsScheme: 'That does not look like a URL. It needs http:// or https://.',

  /** @param {string} value */
  setupUrlRefused: (value) => `"${value}" is not a URL OpenGSO can fetch. Include the scheme, e.g. http://localhost:3000.`,

  /** @param {string} value */
  setupUrlGaveUp: (value) =>
    `"${value}" is not a URL OpenGSO can fetch, and setup ran out of attempts. Nothing was written.`,

  /** @param {string} value */
  endpointNotUrl: (value) =>
    `"${value}" is not a URL OpenGSO can call. Include the scheme, e.g. https://gateway.example.com/v1.`,

  noEndpointGiven: 'No endpoint given, so nothing was written.',

  noKeyEntered: 'No key entered, so nothing was written.',

  setupCancelled: 'Setup was cancelled. Nothing was written.',

  /** The label in front of the reason setup stopped, from `opengso start`. */
  setupStopped: 'setup stopped',

  /** The same label, from `opengso settings`. */
  settingsStopped: 'settings stopped',

  /** @param {string} reason */
  setupScoreFailed: (reason) => `Could not test the site yet: ${reason}`,

  /** @param {number} count */
  pickANumber: (count) => `Pick a number between 1 and ${count}.`,

  crawlerAddRoutingOnly: 'Adding a crawler is only offered for markdown routing.',

  /** @param {string} token */
  unknownCrawler: (token) => `No crawler called "${token}". Type its name or its number, or \`list\` to see them again.`,

  /** @param {string} name */
  crawlerAlreadyListed: (name) => `${name} is already on the list.`,

  portInUseLabel: 'Port in use',

  /**
   * The next port up, except at the top of the range, where there is no next port to suggest.
   *
   * @param {number} port
   */
  portInUse: (port) =>
    `Something is already listening on ${port}. Try \`opengso start -p ${port < 65535 ? port + 1 : port - 1}\`.`,

  /** @param {string[]} flags */
  unknownOptions: (flags) => `Unknown option${flags.length === 1 ? '' : 's'}: ${flags.join(', ')}`,

  /** @param {string} flag */
  optionNeedsValue: (flag) => `${flag} needs a value, as in \`${flag} <value>\`.`,

  /**
   * @param {string} flag
   * @param {string} value
   * @param {{ min: number; max?: number; integer?: boolean; exclusive?: boolean }} rule
   */
  optionNotInRange: (flag, value, rule) => {
    const kind = rule.integer ? 'a whole number' : 'a number';
    const range =
      rule.max !== undefined
        ? `from ${rule.min} to ${rule.max}`
        : rule.exclusive
          ? `above ${rule.min}`
          : `of ${rule.min} or more`;
    return `${flag} takes ${kind} ${range}, and "${value}" is not one.`;
  },

  modeConflict: 'Pick one: --structure runs the checks only, --content runs the AI review only, and neither runs both.',

  onlyNeedsPrompt: '--only picks which checks go into the fix prompt, so it goes with --prompt (print the prompt) or --copy (put it on the clipboard).',

  onlyEmpty: '--only needs at least one check id, as in --only A3 or --only B1,B7.',

  copyNeedsChecks: '--copy copies a fix prompt built from the structural checks, and --content skips them. Drop --content, or use --structure.',

  /**
   * @param {readonly string[]} ids
   * @param {string} known The ids that do exist, as ranges: `A1 to A8, B1 to B14`.
   */
  unknownCheckIds: (ids, known) =>
    `${ids.length === 1 ? 'There is no check' : 'There are no checks'} ${ids.join(', ')}. The checks are ${known}, and docs/checks.md describes each one.`,

  /** @param {readonly string[]} tried The clipboard tools looked for, in order. */
  clipboardUnavailable: (tried) =>
    `Could not reach a clipboard${tried.length > 0 ? ` (tried ${tried.join(', ')})` : ''}. ` +
    'Print the prompt with --prompt and copy it from there, or save it with --prompt --out fix-prompt.md.',

  /** @param {string} tier */
  unknownTier: (tier) => `Unknown tier "${tier}". OpenGSO has two: free (algorithmic, no key) and ai (BYOK).`,

  /** A dashboard API request whose body is not a JSON object. */
  requestNotObject: () => 'The request body has to be a JSON object.',

  /** @param {string} route The method and path, as `GET /api/nope`. */
  noSuchEndpoint: (route) => `No such endpoint: ${route}`,

  filePathRequired: 'Expected a path relative to the public directory.',

  /** @param {string} relative */
  noGeneratedFile: (relative) => `There is no generated file at ${relative}.`,

  /** @param {string} api */
  unknownApiShape: (api) => `Unknown API shape "${api}". OpenGSO speaks three: anthropic, openai, gemini.`,

  /** @param {string} auth */
  unknownAuthStyle: (auth) => `Unknown auth style "${auth}". Use one of: bearer, x-api-key, x-goog-api-key, none.`,

  /** @param {string} mode */
  unknownTestMode: (mode) => `Unknown test mode "${mode}". Pick one of: full, structure, content.`,

  /**
   * @param {string} field
   * @param {string} expected `string`, `boolean` or `number`.
   * @param {unknown} value
   */
  requestFieldType: (field, expected, value) =>
    `${field} in the request has to be a ${expected}, and it is ${JSON.stringify(value) ?? String(value)}.`,

  /**
   * @param {string} url
   * @param {string} reason
   */
  fetchFailed: (url, reason) =>
    [
      `Couldn't reach ${url}`,
      `  ${reason}`,
      ``,
      `If this is a local dev server, check it's running and on the port you expect.`,
    ].join('\n'),

  // Every caller prints the route beside this, so it is not repeated here.
  /** @param {string} finalOrigin */
  redirectedOffSite: (finalOrigin) =>
    `Redirected to ${finalOrigin}, which is another origin, so its content was not used as this site's twin - skipped.`,

  /**
   * @param {string} site
   * @param {string} finalOrigin
   */
  startRedirectedOffSite: (site, finalOrigin) =>
    `The start URL on ${site} redirects to ${finalOrigin}, so nothing was crawled. If that is the site's real address, run generate against ${finalOrigin} instead.`,

  /**
   * @param {number} maxPages
   * @param {number} queued
   */
  crawlPageCap: (maxPages, queued) =>
    `Stopped at the ${maxPages}-page cap (every request counts, failed ones too) with ${queued} route${queued === 1 ? '' : 's'} still queued. Raise crawl.maxPages in opengso.config.json to go further.`,

  /** @param {number} maxDepth */
  crawlDepthCap: (maxDepth) =>
    `Stopped following links at depth ${maxDepth}. Raise crawl.maxDepth in opengso.config.json, or list the deeper routes in extraRoutes.`,

  /**
   * @param {string} feature
   * @param {readonly { name: string; provider: string }[]} [lookalikes] `.env` lines that look like
   *   a key under a name OpenGSO does not read. Named first, because "none is configured" is not
   *   what the person who wrote `claude_api=sk-ant-...` believes, and they are right.
   */
  noApiKey: (feature, lookalikes = []) =>
    [
      `${feature} needs an AI provider, and none is configured.`,
      ...lookalikeLines(lookalikes),
      ``,
      `OpenGSO is bring-your-own-key, and it does not care whose. Set one up with:`,
      `  opengso settings`,
      ``,
      `Or add it to .env yourself:`,
      `  OPENGSO_PROVIDER=anthropic`,
      `  OPENGSO_API_KEY=sk-...`,
      ``,
      `Providers OpenGSO ships with:`,
      ...wrapList(AI_PROVIDERS, 68).map((line) => `  ${line}`),
      ``,
      `\`ollama\` runs on this machine and needs no key at all. \`custom\` points at any endpoint`,
      `speaking the OpenAI, Anthropic or Gemini shape: set ai.baseUrl and ai.model in`,
      `opengso.config.json, or run \`opengso settings\` and pick "something else".`,
      ``,
      `Only these need a key: generate's AI tier, and \`opengso test --content\`.`,
      `Structural tests, generate's free tier, and opengso-prod never need one.`,
    ].join('\n'),

  /**
   * The content review was not asked for by name, so a missing key is a note under the report and
   * not the full set-up guide `noApiKey` gives a command that cannot run without one. Every
   * keyless `opengso test` ends with this, so it stays short. The first line is the reason, which
   * is all the dashboard shows.
   *
   * @param {readonly { name: string; provider: string }[]} [lookalikes]
   */
  contentReviewSkipped: (lookalikes = []) =>
    [
      `No AI provider is configured, so only the structural checks ran.`,
      `The score above never needs one. \`opengso settings\` sets one up when you want the writing`,
      `reviewed too, and \`opengso help providers\` lists every provider it ships with.`,
      ...lookalikeLines(lookalikes),
    ].join('\n'),

  /**
   * A provider that is real but not yet usable: `custom` with no endpoint, or any provider whose
   * model was never named. Says which field is missing rather than failing at the HTTP layer with
   * whatever a half-built URL produced.
   *
   * @param {string} provider
   * @param {string[]} missing
   */
  providerIncomplete: (provider, missing) =>
    [
      `The "${provider}" provider is missing ${missing.join(' and ')}.`,
      ``,
      `An endpoint OpenGSO does not ship with has to be described before it can be called. In`,
      `opengso.config.json:`,
      ``,
      `  "ai": {`,
      `    "provider": "${provider}",`,
      `    "model": "the model id your endpoint expects",`,
      `    "baseUrl": "https://your-endpoint.example.com/v1",`,
      `    "api": "openai"`,
      `  }`,
      ``,
      `"api" is the wire format that endpoint speaks: openai, anthropic or gemini.`,
      `\`opengso settings\` asks for all of it if you would rather answer questions.`,
    ].join('\n'),

  /**
   * The provider answered one document in a way that holds for all of them (a refused key, an empty
   * account, a model that does not exist), so the rest were never sent: each would have failed the
   * same way, and some providers bill or rate-limit refused calls.
   *
   * @param {number} status
   * @param {number} notSent
   */
  contentReviewHalted: (status, notSent) =>
    [
      // Every document can be in the first batch, and then nothing was held back to mention.
      notSent === 0
        ? `The provider answered ${status}, so no document was reviewed.`
        : `The provider answered ${status}, so the content review stopped and ${notSent} document${notSent === 1 ? ' was' : 's were'} not sent.`,
      stopCause(status, 'run again'),
    ].join('\n'),

  contentDocumentNotSent: 'Not sent: the provider turned down an earlier document for a reason that applies to every one, so this one would have failed the same way.',

  /** @param {number} count */
  contentReviewAllFailed: (count) =>
    `None of the ${count} document${count === 1 ? '' : 's'} could be reviewed. Each one's error is listed above; a wrong model name or a provider outage are the usual causes.`,

  /** @param {string} feature */
  ciBlocked: (feature) =>
    [
      `${feature} is a local-machine-only feature and won't run in CI.`,
      ``,
      `This is deliberate: anything AI-touched gets a human review before it ships, rather than`,
      `silently regenerating unattended on every deploy.`,
      ``,
      `Run it on your own machine, review the result, and commit the output.`,
    ].join('\n'),

  /** @param {string} file */
  twinNotOurs: (file) =>
    `${file} already exists and OpenGSO did not write it, so it was left alone and the twin went to ${file}.opengso-proposed. Add generated_by: manual to its frontmatter to serve yours, or use --force to replace it.`,

  /** @param {string} file */
  wouldOverwrite: (file) =>
    [
      `${file} already exists and wasn't written by OpenGSO - leaving it alone.`,
      ``,
      `A hand-written file here often carries intentional rules a blind overwrite would erase.`,
      `OpenGSO wrote its proposed version to ${file}.opengso-proposed instead, so you can diff and`,
      `merge whatever you actually want.`,
      ``,
      `To overwrite for real: opengso generate <url> --force`,
    ].join('\n'),

  /** @param {string} dir */
  noGeneratedOutput: (dir) =>
    [
      `No generated markdown found in ${dir}.`,
      ``,
      `Run \`opengso generate <url>\` first - prod only ever serves files that already exist on disk.`,
    ].join('\n'),

  /**
   * @param {string} provider
   * @param {string[]} supported
   */
  unknownProvider: (provider, supported) => {
    const meant = suggestProvider(provider);
    return [
      `Unknown AI provider "${provider}".${meant && meant !== provider ? ` Did you mean "${meant}"?` : ''}`,
      ``,
      `OpenGSO supports:`,
      ...wrapList(supported, 68).map((line) => `  ${line}`),
      ``,
      `If yours is not on that list it is still supported: pick "custom", give it a baseUrl and a`,
      `model, and OpenGSO will talk to it. No code change, no waiting for a release.`,
      `\`opengso help providers\` shows each one with its default model and where its keys come from.`,
    ].join('\n');
  },

  /**
   * The provider variable is the key's destination, so a value that names none sends it nowhere.
   *
   * @param {string} value
   * @returns {string}
   */
  envProviderUnknown: (value) => {
    const meant = suggestProvider(value);
    return [
      `OPENGSO_PROVIDER is set to "${value}", which is not a provider OpenGSO knows.${meant ? ` Did you mean "${meant}"?` : ''}`,
      `The key next to it is not sent anywhere until that names one. Fix it in .env (or your shell),`,
      `or run \`opengso settings\` and pick the provider from the list.`,
    ].join('\n');
  },

  /**
   * Names both providers and never the key itself.
   *
   * @param {AiProvider} provider
   * @param {AiProvider} keyProvider
   */
  keyForOtherProvider: (provider, keyProvider) => {
    const native = providerInfo(provider).envVars[0];
    return [
      `The ${provider} provider was asked for, but the only key OpenGSO found belongs to ${keyProvider}, so`,
      `nothing was sent. A key only ever goes to the provider that issued it.`,
      ``,
      `To use ${provider}, give it its own key in .env:`,
      ...(native ? [`  ${native}=...`, `or:`] : []),
      `  OPENGSO_PROVIDER=${provider}`,
      `  OPENGSO_API_KEY=...`,
      ``,
      `Or run \`opengso settings\` and pick ${provider}.`,
    ].join('\n');
  },

  /**
   * Names the variable and never echoes the value: the value may be the key.
   *
   * @param {string} name
   */
  envValueRefused: (name) =>
    [
      `The value for ${name} contains a line break or another control character, so nothing was written.`,
      ``,
      `.env holds one variable per line, and a line break would let the value write a second one.`,
      `Paste it again without the trailing newline.`,
    ].join('\n'),

  badRequestTarget: () => 'That request asked for a path the dashboard could not read.',

  /** @param {string} webRoot */
  dashboardMissing: (webRoot) =>
    [
      `The dashboard files are missing.`,
      ``,
      `Expected them at: ${webRoot}`,
      ``,
      `They ship in the opengso package's web/ folder, so reinstalling opengso puts them back. There is`,
      `nothing to build: in a clone they are packages/opengso/web as checked out. --web <dir> points the`,
      `dashboard at any folder with an index.html.`,
    ].join('\n'),

  /** @param {string} method */
  staticMethod: (method) => `${method} is not something the dashboard's pages answer. They are only read, with GET or HEAD.`,

  keyMissing: () => 'No key was provided, so nothing was written.',

  /** @param {string} provider */
  keyNotKept: (provider) =>
    `Paste the key for ${provider}. A blank key only keeps the saved one when the provider and endpoint stay the same, so a saved key is never sent somewhere it was not pasted for. Nothing was written.`,

  /** @param {'test' | 'generate'} kind */
  runInProgress: (kind) =>
    `A ${kind} is already running for this project. Wait for it to finish, or close the tab that started it, which stops it.`,

  jsonRequired: () =>
    `The dashboard API only accepts a POST sent as Content-Type: application/json. That is what keeps a form on another site from posting here.`,

  serverFailed: () =>
    [
      `Something went wrong inside the dashboard server.`,
      ``,
      `The details are in the terminal running \`opengso start\`. They stay there rather than being`,
      `sent to the browser, because they can carry file paths from this machine.`,
    ].join('\n'),

  aiViaConfigRefused: () =>
    [
      `The AI provider cannot be changed through /api/config.`,
      ``,
      `Use the AI provider card in Settings, which posts to /api/key, or run \`opengso settings\`.`,
      `Both save the provider, endpoint and key together and check them first, so a stored key is`,
      `never pointed at a host nobody typed it for.`,
    ].join('\n'),

  /** @param {string | undefined} host */
  hostRefused: (host) =>
    [
      `Refused: this dashboard only answers to the address it was started on, and the request was`,
      `addressed to ${host === undefined ? 'no host at all' : `"${host}"`}.`,
      ``,
      `Open the URL that \`opengso start\` printed. A page reaching this server under any other name`,
      `is how a website tries to talk to a local server through DNS rebinding.`,
    ].join('\n'),

  tokenRequired: () =>
    [
      `Refused: this dashboard is reachable from the network, so every request needs the token it was`,
      `started with, and this one had none or the wrong one.`,
      ``,
      `Open the full URL that \`opengso start\` printed, including ?token=. The token changes every time`,
      `the dashboard starts, so a URL from an earlier launch no longer works.`,
    ].join('\n'),

  /**
   * @param {string} provider
   * @param {number} status
   * @param {string | null} location
   */
  providerRedirected: (provider, status, location) =>
    [
      `The ${provider} API answered ${status} with a redirect${location ? ` to ${redirectHost(location)}` : ''}, and OpenGSO does not follow it.`,
      `A redirect would send your key to a host you did not configure. If the endpoint moved, put`,
      `its new address in ai.baseUrl in opengso.config.json.`,
    ].join('\n'),

  /**
   * @param {string} provider
   * @param {string} body
   */
  providerNotJson: (provider, body) =>
    [
      `The ${provider} API answered, but not with JSON, so there is no reply to read. Something in front`,
      `of the endpoint (a proxy, a gateway, a login page) may be answering instead; check ai.baseUrl.`,
      `  ${body.slice(0, 400)}`,
    ].join('\n'),

  /**
   * @param {number} count
   * @param {string} named
   */
  aiInventedFacts: (count, named) =>
    `The model's version states ${count} fact${count === 1 ? '' : 's'} the page does not: ${named}.`,

  /** @param {string} provider */
  aiOutputTruncated: (provider) =>
    `${provider} stopped at the output cap before the page was finished, so the cut-off rewrite was not used.`,

  /**
   * @param {number} tokens
   * @param {number} cap
   */
  aiPageTooLong: (tokens, cap) =>
    `Not sent to the AI tier, so the algorithmic version was kept: this page is about ${tokens} tokens and the model's output cap is ${cap}, so a full rewrite could not fit and the call would be paid for and thrown away.`,

  /** @param {number} status */
  aiStoppedEarlier: (status) =>
    `Not sent to the AI tier, so the algorithmic version was kept: the provider answered ${status} on an earlier page, and this one would have failed the same way. ${stopCause(status, 'run generate again')}`,

  /**
   * @param {string} provider
   * @param {number} seconds
   * @param {boolean} chosen The limit came from `test --timeout` rather than the built-in default,
   *   so the likely fix is a bigger number rather than a quieter provider.
   */
  providerTimeout: (provider, seconds, chosen) =>
    `The ${provider} API did not respond within ${seconds}s.\n  ${
      chosen
        ? 'A model reading a whole page can need longer than a page load: raise --timeout, or leave it out for the default of two minutes.'
        : 'The provider may be overloaded; running it again in a few minutes usually works.'
    }`,

  /**
   * A 200 with nothing in it. The kind of content the shape was looking for is named, so a gateway
   * that answers in another API's shape is recognisable.
   *
   * @param {string} provider
   * @param {string} kind
   */
  providerEmpty: (provider, kind) => `${provider} returned no ${kind} content.`,

  /** @param {string} why */
  aiFallbackCached: (why) =>
    `Source unchanged since the last run, when the AI tier kept the algorithmic version (${why}). Not sent to the model again; --force retries it.`,

  /** @param {string} message */
  pageCrashed: (message) => `Could not generate this page: ${message}. The rest of the run carried on.`,

  /**
   * Filesystem failures, built by `describeFsError` in shared/fs.js. Each is a clause that reads
   * after "Could not generate this page:" and on its own under "Error".
   *
   * @param {string} path
   * @param {'read' | 'write'} action
   */
  fsNoPermission: (path, action) => `no permission to ${action} ${path}`,
  /** @param {string} path */
  fsNotAFolder: (path) => `${path} is a file, not a folder, so nothing can be written under it`,
  /** @param {string} path */
  fsMissing: (path) => `${path} does not exist`,
  /** @param {string} path */
  fsDiskFull: (path) => `the disk is full, so ${path} could not be written`,
  /** @param {string} path */
  fsReadOnly: (path) => `${path} is on a read-only file system`,
  /** @param {string} path */
  fsTooManyOpen: (path) => `too many files are open, so ${path} could not be written`,

  /**
   * `--project` names the folder that holds opengso.config.json. Pointing it at nothing used to be
   * accepted silently, and every command then read or created a config somewhere the user did not
   * mean.
   *
   * @param {string} dir As typed on the command line.
   */
  projectMissing: (dir) => `--project ${dir} does not exist. Give it the folder that holds opengso.config.json, or where you want one created.`,
  /** @param {string} dir */
  projectNotAFolder: (dir) => `--project ${dir} is a file, not a folder. Give it the folder that holds opengso.config.json.`,

  /**
   * @param {string} path
   * @param {string} why
   */
  manifestUnreadable: (path, why) =>
    `${path} could not be read (${why}), so this run started without it: every page is regenerated and nothing from the last run is carried forward. It is rewritten when the run finishes.`,

  /**
   * @param {string} path
   * @param {string} aside
   */
  historySetAside: (path, aside) =>
    `${path} could not be read, so it was moved to ${aside} rather than written over, and the score history starts again from this run.`,

  /**
   * @param {string} site
   * @param {string} why From `whyUnreachable`, or the status the start page answered with.
   * @param {boolean} kept Whether an earlier run left a manifest, which this run keeps as it was.
   */
  siteUnreachable: (site, why, kept) =>
    kept
      ? `Could not fetch ${site} (${why}), so the manifest was kept as it was and every existing twin is still served. Start the site and run generate again.`
      : `Could not fetch ${site} (${why}), so nothing was written. Start the site, with \`npm run dev\` or however you run it, and run generate again.`,

  /** @param {string} origin */
  loopbackPublicOrigin: (origin) =>
    `sitemap.xml, robots.txt, llms.txt and every twin point at ${origin}, which only this machine can reach. Deployed like this, they send crawlers and agents nowhere. Set "publicOrigin" in opengso.config.json to where the site is deployed, e.g. "https://example.com", and run generate again.`,

  /** @param {string} why */
  pruneRefused: (why) =>
    `--prune was given, but ${why}, so a page missing from this run may still exist. Nothing was pruned.`,

  /**
   * @param {string} file
   * @param {string} why
   */
  pruneFailed: (file, why) => `${file} is orphaned but could not be deleted (${why}). It is still listed as orphaned.`,

  /** @param {number} count */
  orphansFound: (count) =>
    `${count === 1 ? 'This twin was' : `These ${count} twins were`} written by OpenGSO for a page this run did not find. ${count === 1 ? 'It is' : 'They are'} no longer listed in llms.txt or sitemap.xml or served by opengso-prod, but the file${count === 1 ? ' is' : 's are'} still on disk and a static host still serves ${count === 1 ? 'it' : 'them'}. If the page is gone for good, run generate again with --prune to delete ${count === 1 ? 'it' : 'them'}.`,

  // Every caller prints the route beside this, so it is not repeated here.
  unsafeRoute: 'Has a "." or ".." segment, so its twin would be written outside public/md/ - skipped. List the route without them.',

  /**
   * @param {string} file
   * @param {string} otherRoute
   */
  twinFileCollision: (file, otherRoute) =>
    `Its twin would be ${file}, the same file as ${otherRoute}'s, so it was skipped rather than overwrite that one. "/" and "/index", or two routes that differ only in letter case, cannot both have a twin.`,

  /** @param {number} maxBytes */
  pageTooLarge: (maxBytes) => `Larger than ${Math.round(maxBytes / (1024 * 1024))} MB - skipped.`,

  // -- generating from files ----------------------------------------------------------------------

  /**
   * @param {string} folder As the user would type it.
   * @param {string} name The folder's own name, for the `cd ..` suggestion.
   */
  filesAtProjectRoot: (folder, name) =>
    [
      `${folder} is the project root, and OpenGSO will not use the project root as the web root.`,
      ``,
      `Generate writes the twins, robots.txt, llms.txt and sitemap.xml into the folder it reads, and`,
      `everything in that folder gets published. The project root is also where .env (your AI key) and`,
      `OpenGSO's own .opengso/ folder live, so publishing it would publish them.`,
      ``,
      `Move the site's pages, styles and scripts into a folder of their own and point generate at it:`,
      ``,
      `  opengso generate site`,
      ``,
      `GitHub Pages can publish from a docs/ folder; Netlify, Vercel and Cloudflare Pages take any folder`,
      `as the publish directory.`,
      ``,
      `If ${folder} already is the site's own folder and holds nothing else, run generate from the folder`,
      `above it instead, which makes that one the project:`,
      ``,
      `  cd .. && opengso generate ${name}`,
    ].join('\n'),

  /**
   * @param {string} folder
   * @param {string} root
   */
  filesOutsideProject: (folder, root) =>
    `${folder} is outside this project (${root}), and generate only writes inside the project it runs in. Run it from the folder that holds ${folder}, or pass --project.`,

  /** @param {string} page */
  filesSingleNeedsSite: (page) =>
    `${page} is one page of a site generate has not read yet, so it does not know which folder is the web root. Generate the whole folder once, e.g. \`opengso generate site\`; after that, \`opengso generate site/about.html\` regenerates a single page.`,

  /** @param {string} folder */
  filesSingleNeedsPage: (folder) =>
    `--single regenerates one page, and ${folder} is a folder. Name the page instead: opengso generate ${folder.replace(/\/+$/, '')}/about.html`,

  /**
   * @param {string} folder The folder that was asked for, relative to the project.
   * @param {string} publicDir What the config says.
   */
  filesWebRootMismatch: (folder, publicDir) =>
    [
      `opengso.config.json says the web root is ${publicDir}/, but generate was pointed at ${folder}/.`,
      ``,
      `  opengso generate ${publicDir}        read the configured folder`,
      ``,
      `Or, if ${folder}/ is where the site really lives, set "publicDir": "${folder}" in opengso.config.json`,
      `(\`opengso settings\` asks for it) and run this again.`,
    ].join('\n'),

  /** @param {string} folder */
  filesWebRootMissing: (folder) =>
    `The web root ${folder}/ does not exist. Generate reads the HTML files in it, so point it at the folder your site is published from, e.g. opengso generate site.`,

  /** @param {number} words */
  thinContentDevServer: (words) =>
    `Only ${words} words of content, from a page that loads the Vite dev client: this dev server builds the page in the browser, so the HTML is an empty shell. Build the site and crawl what the build serves instead (\`npm run build\`, then \`npm run preview\` or your framework's preview command), which is what agents will see.`,

  /**
   * A warning, not a failure: a short page is allowed to be short. The part worth saying is the
   * case where the words exist but only appear once a script runs, because then they never will.
   *
   * @param {number} words
   * @param {number} threshold
   */
  thinContent: (words, threshold) =>
    `Only ${words} words of content (the warning starts below ${threshold}). If the page fills in its text with JavaScript, OpenGSO cannot see that text: it reads the HTML without running scripts, the way most AI crawlers do. If the page really is that short, lower generate.minWords.`,

  /** @param {string} folder */
  noHtmlFiles: (folder) =>
    `There are no .html pages in ${folder}/ to read. Point generate at the folder your site is published from (the one with index.html in it), or at a running site's URL.`,

  /**
   * @param {string} file
   * @param {string} folder
   */
  htmlFileOutsideWebRoot: (file, folder) =>
    `${file} is not inside the web root ${folder}/. Generate only reads pages from the web root, because that is where it writes their twins.`,

  /** @param {string} file */
  htmlFileNotAPage: (file) =>
    `${file} is not a page generate reads: it is excluded by crawl.exclude, sits in a folder that starts with "." or "_", or is an error page.`,

  /** @param {string} value */
  badOrigin: (value) =>
    `--origin needs the address the site is published at, e.g. --origin https://example.com, or --origin https://user.github.io/repo for a site in a folder of its host, not "${value}".`,

  /** @param {string} base */
  folderSiteCrawl: (base) =>
    `${base} is a site in a folder of its host, and generate crawls only a site at the root of one. Build the site and generate from the build folder instead: opengso generate <the build folder> --origin ${base}, which writes each twin beside its page.`,

  /** @param {string} base */
  robotsOutsideFolder: (base) => {
    const url = new URL(base);
    return `robots.txt was not written: crawlers read it only at the root of the host, ${url.origin}/robots.txt, and this site lives in ${url.pathname.replace(/\/+$/, '')}/. If you publish that root too (on GitHub Pages, from the user.github.io repository), add "Sitemap: ${base}/sitemap.xml" to the robots.txt there.`;
  },

  /** @param {string} origin */
  filesOriginUnknown: (origin) =>
    `No public address is known for this site, so sitemap.xml, llms.txt and every twin point at ${origin}, which only this machine can reach. Run generate again with --origin https://your-domain.com and OpenGSO will remember it.`,

  /**
   * @param {string} origin
   * @param {string} file
   */
  originFromCanonical: (origin, file) =>
    `Using ${origin} as the site's public address, from the canonical link in ${file}. Pass --origin to use a different one.`,

  /**
   * @param {string} given
   * @param {string} configured
   */
  originDiffersFromConfig: (given, configured) =>
    `This run used --origin ${given}, but opengso.config.json says "publicOrigin": "${configured}". The next run without --origin goes back to ${configured}; change it there to make ${given} stick.`,

  /**
   * Pages whose canonical link names some other page, or one address shared by several of them.
   * Usually a template that hard-codes the home page's canonical into every page.
   *
   * @param {string} url
   * @param {string[]} files
   * @param {string} [owner] The page that address belongs to, when there is one.
   */
  canonicalNotOwn: (url, files, owner) => {
    const many = files.length > 1;
    const shown = files.length > 4 ? [...files.slice(0, 3), `${files.length - 3} more`] : files;
    const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
    return (
      `${list} ${many ? 'all declare' : 'declares'} ${url}${owner ? `, the address of ${owner},` : ''} as ${many ? 'their' : 'its'} canonical URL, ` +
      `which tells search engines and agents ${many ? 'they are copies' : 'it is a copy'} of that page. Unless that is true, each page should name its own address in <link rel="canonical">. ` +
      `${many ? 'Their twins use their' : 'Its twin uses its'} own address.`
    );
  },

  /** @param {number} max */
  filesCapped: (max) =>
    `The folder holds more than ${max} pages, so only the first ${max} were read (the home page first, then in path order). Raise crawl.maxPages in opengso.config.json, or pass --max-pages, to read them all.`,

  /** @param {string} folder */
  noJekyllWritten: (folder) =>
    `Wrote an empty .nojekyll to ${folder}/. GitHub Pages runs Jekyll over a folder without one, and Jekyll would turn every twin into an HTML page instead of serving it as markdown. Commit it with the twins.`,

  /** @param {string} folder */
  jekyllSource: (folder) =>
    `${folder}/ is the source of a Jekyll site, and Jekyll turns every .md file with frontmatter into an HTML page, so twins written here would never be served as markdown, and index.md would be built over index.html. Build the site first (bundle exec jekyll build), run opengso generate _site, and publish _site as it is: on GitHub Pages, with a GitHub Actions workflow rather than from the branch.`,

  /** @param {string} folder */
  jekyllWillConvertTwins: (folder) =>
    `If GitHub Pages publishes ${folder}/, add an empty file named .nojekyll to it. Without one GitHub Pages runs Jekyll, which turns every .md file with frontmatter into an HTML page, so the twins would not be served as markdown and index.md would be built over index.html.`,

  /**
   * @param {string} file
   * @param {string} winner
   * @param {string} route
   */
  sameUrlFiles: (file, winner, route) =>
    `${file} and ${winner} are both served at ${route}. The twin was made from ${winner}; rename or delete the other one.`,

  /**
   * @param {string} file
   * @param {string} why
   */
  sourceUnreadable: (file, why) => `${file} could not be read (${why}), so its twin was left as it was.`,

  /** @param {string} configPath */
  filesConfigCreated: (configPath) =>
    `Saved ${configPath} with this folder as the web root, so \`opengso generate\`, the dashboard and \`opengso-prod\` all find it from now on.`,

  /** @param {string} why */
  webRootFromFramework: (why) =>
    `No opengso.config.json here, so the files went where the framework serves them: ${why}. Set "publicDir" in opengso.config.json to put them somewhere else.`,

  /** @param {string} origin */
  filesOriginSaved: (origin) => `Saved "publicOrigin": "${origin}" to opengso.config.json, so the next run uses it without --origin.`,

  filesSourceTip:
    'To make a bare `opengso generate` and the dashboard read these files too, set "generate": { "source": "files" } in opengso.config.json.',

  /** @param {string} folder */
  checkBeforeGenerate: (folder) =>
    `Nothing has been generated from ${folder}/ yet, so there is no twin to compare. Run \`opengso generate ${folder}\` first.`,

  fileNeedsFilesSource: 'A single file can only be regenerated in a project that reads its HTML files ("generate": { "source": "files" }).',

  checkNeedsFiles:
    '--check compares each twin with the HTML file it was made from, and a crawled site has no file to compare with. `opengso test <url>` checks a crawled site\'s twins against its live pages instead (check B14). To check a folder, run `opengso generate <folder> --check`.',

  // -- freshness ----------------------------------------------------------------------------------

  /**
   * @param {string} file
   * @param {string} twin
   * @param {string} modified
   * @param {string} written
   * @param {boolean} after Whether the file's date is later than the twin's. A file copied with its
   *   old date kept can differ from the twin's source and still be dated earlier.
   */
  staleChanged: (file, twin, modified, written, after) =>
    after
      ? `${file} was modified ${modified}, after its twin ${twin} was written ${written}.`
      : `${file} is not the file its twin ${twin} was made from (the file is dated ${modified}, the twin ${written}).`,

  /**
   * @param {string} file
   * @param {string} twin
   * @param {string} modified
   * @param {string} saved
   */
  staleManual: (file, twin, modified, saved) =>
    `${file} was modified ${modified}, after your hand-written twin ${twin} was last saved ${saved}. OpenGSO never rewrites it, so update it yourself or remove generated_by: manual to let generate take it over.`,

  /**
   * @param {string} file
   * @param {string} twin
   */
  staleMissing: (file, twin) => `${file} no longer exists, but its twin ${twin} is still listed and served.`,

  /** @param {string} file */
  staleNew: (file) => `${file} has no twin yet.`,

  /**
   * One line for after the list, saying what fixes each kind that is in it.
   *
   * @param {{ changed: number; manual: number; missing: number; new: number }} counts
   * @param {string} command The generate command that reads this project's files.
   */
  staleRemedy: (counts, command) => {
    /** @type {string[]} */
    const parts = [];
    if (counts.changed + counts.new + counts.missing > 0) parts.push(`Run \`${command}\` to bring the twins up to date`);
    if (counts.missing > 0) parts.push('add --prune to delete the twins of pages that are gone');
    if (counts.manual > 0) parts.push('hand-written twins are yours to update');
    return parts.length === 0 ? '' : `${parts.join('; ')}.`;
  },

  /**
   * Takes the place of "Nothing was written." when setup or settings stops after it already had.
   *
   * @param {string[]} files
   */
  stoppedAfterWriting: (files) => `Already written before that, and left as it is: ${files.join(', ')}.`,

  /**
   * What the failure cost is the caller's to say: generate still writes the algorithmic twin, and
   * test --quality writes nothing at all, so a fixed "nothing was written" was wrong for generate.
   *
   * @param {string} provider
   * @param {number} status
   * @param {string} body
   * @param {string} [model]
   */
  providerFailed: (provider, status, body, model) => {
    const hint = statusHint(status, model);
    return [`The ${provider} API returned ${status}.`, `  ${body.slice(0, 400)}`, ...(hint ? [hint] : [])].join('\n');
  },

  /**
   * A model that declined the page. The HTTP status cannot say so, because the answer was a 200.
   *
   * @param {string} provider
   */
  providerRefused: (provider) =>
    `${provider} declined to rewrite this page. The key is fine: the model's own safety rules stopped it, so the algorithmic version is kept.`,
});
