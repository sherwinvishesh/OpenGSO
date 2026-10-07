/**
 * Every user-facing error string in OpenGEO lives here (§13).
 *
 * One shared module, imported by all five published packages, so wording only ever changes in one
 * place and a limited install can tell the user exactly which package to reach for instead.
 */

import { AI_PROVIDERS, PROVIDERS, providerInfo } from './providers.js';

/** @import { AiProvider } from './providers.js' */

/**
 * The errors config loading can raise, kept apart from `ERRORS` because `opengeo-prod` loads the
 * config on every boot and `ERRORS` reaches into the provider catalogue. Nothing in here may
 * reference a provider, or prod's bundle grows AI code and `check:bundles` fails the build.
 */
export const CONFIG_ERRORS = /* @__PURE__ */ Object.freeze({
  /**
   * @param {string} field
   * @param {unknown} value
   * @param {string} root
   */
  dirOutsideProject: (field, value, root) =>
    [
      `${field} in opengeo.config.json is ${JSON.stringify(value)}, which is not a directory inside the project.`,
      ``,
      `It has to be a relative path to a folder below ${root}, such as "public". The project root`,
      `itself is refused too: it holds .env, and anything OpenGEO can read or write there is too much.`,
    ].join('\n'),

  /**
   * @param {string} field
   * @param {string} expected
   * @param {unknown} value
   */
  badField: (field, expected, value) =>
    `${field} in opengeo.config.json has to be ${expected}, and it is ${JSON.stringify(value) ?? String(value)}.`,

  /**
   * @param {string} path
   * @param {string} reason
   */
  unreadable: (path, reason) =>
    [
      `${path} could not be read: ${reason}`,
      ``,
      `Fix the file by hand, or delete it and run \`opengeo settings\` to write a fresh one.`,
    ].join('\n'),

  /**
   * The one line opengeo-prod logs at boot instead of crashing the site. One line, because it lands
   * in a hosting platform's deploy log next to everything else.
   *
   * @param {string} problem A message from one of the entries above.
   */
  prodFailedOpen: (problem) =>
    `[opengeo-prod] markdown is off, and every request passes through to the normal site, until opengeo.config.json is fixed: ${problem.split('\n')[0]}`,
});

/**
 * Problems prod's twin store reports at boot. Same rule as `CONFIG_ERRORS`: this ships inside
 * opengeo-prod, so nothing in here may reference a provider.
 */
export const STORE_ERRORS = /* @__PURE__ */ Object.freeze({
  /**
   * @param {string} route
   * @param {string} file The manifest's `file` value, as written.
   * @param {string} publicDir
   */
  twinOutsidePublicDir: (route, file, publicDir) =>
    `Manifest lists ${route} at ${file}, which resolves outside ${publicDir}, so it was not loaded. ` +
    'OpenGEO only ever writes twins inside publicDir: rerun `opengeo generate` to rewrite the manifest.',
});

/** @typedef {'test' | 'generate' | 'settings' | 'start' | 'prod test'} CommandName */

/**
 * Which published packages actually ship each command (§10).
 *
 * @type {Record<CommandName, string[]>}
 */
export const COMMAND_PACKAGES = {
  test: ['opengeo', 'opengeo-cli', 'opengeo-testing'],
  generate: ['opengeo', 'opengeo-cli', 'opengeo-generate'],
  settings: ['opengeo', 'opengeo-cli'],
  start: ['opengeo'],
  'prod test': ['opengeo', 'opengeo-cli', 'opengeo-prod'],
};

/** @type {Record<CommandName, string>} */
export const COMMAND_BLURB = {
  test: 'scores a live URL 0-100 for AI-readiness',
  generate: 'writes the .md twins, robots.txt, llms.txt and sitemap.xml',
  settings: 'change the site, the bot lists and the API key, in your terminal',
  start: 'sets the project up, then opens the OpenGEO dashboard',
  'prod test': 'verifies a deployed opengeo-prod middleware is serving correctly',
};

/**
 * The narrowest package that ships a given command, for the "install just this" suggestion.
 *
 * @type {Record<CommandName, string>}
 */
export const NARROWEST_PACKAGE = {
  test: 'opengeo-testing',
  generate: 'opengeo-generate',
  settings: 'opengeo-cli',
  start: 'opengeo',
  'prod test': 'opengeo-prod',
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
};

/**
 * Shown when a limited install is asked for a command it doesn't include - e.g. someone installed
 * only `opengeo-testing` and ran `opengeo generate`.
 *
 * The suggestions are derived rather than written out, because two of the five commands make the
 * hand-written version wrong: `opengeo-cli` does not ship `start`, and it is itself the narrowest
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
    narrowest === 'opengeo'
      ? [`The fix:`, `  npm install -D opengeo`]
      : [
          `Two ways forward:`,
          `  just this one thing   npm install -D ${narrowest}`,
          `  all of OpenGEO        npm install -D opengeo`,
        ];
  return [
    `\`opengeo ${command}\` isn't part of ${installedPackage}.`,
    ``,
    `You have ${installedPackage} installed, which doesn't include the ${pillar ? `${pillar} pillar` : `${command} command`}.`,
    `\`opengeo ${command}\` ${COMMAND_BLURB[command]}.`,
    ``,
    ...ways,
    ``,
    `Packages that ship \`opengeo ${command}\`: ${COMMAND_PACKAGES[command].join(', ')}.`,
  ].join('\n');
}

/**
 * @param {string} command
 * @param {CommandName[]} available
 * @returns {string}
 */
export function unknownCommand(command, available) {
  return [
    `Unknown command: \`opengeo ${command}\`.`,
    ``,
    available.length > 0
      ? `This install can run: ${available.map((c) => `opengeo ${c}`).join(', ')}.`
      : `This install ships no CLI commands.`,
    `Run \`opengeo --help\` for the full list.`,
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

/**
 * One line per provider, for `--help` and the settings screen.
 *
 * @returns {string[]}
 */
export function providerListing() {
  const width = Math.max(...PROVIDERS.map((provider) => provider.id.length));
  return PROVIDERS.map((provider) => {
    const info = providerInfo(provider.id);
    const suffix = info.keyless ? ' (no key, on this machine)' : info.userDefined ? ' (your own endpoint)' : '';
    return `${provider.id.padEnd(width + 2)}${info.label}${suffix}`;
  });
}

export const ERRORS = /* @__PURE__ */ Object.freeze({
  /** @param {string} command */
  missingUrl: (command) =>
    [
      `\`opengeo ${command}\` needs a URL.`,
      ``,
      `OpenGEO always works against a URL, never a source directory - it has to see what your site`,
      `actually serves over HTTP: real headers, real response, real rendering result.`,
      ``,
      `  opengeo ${command} http://localhost:3000`,
      `  opengeo ${command} https://your-site.com`,
    ].join('\n'),

  /** @param {string} value */
  invalidUrl: (value) =>
    `"${value}" isn't a URL OpenGEO can fetch. Include the scheme, e.g. http://localhost:3000 or https://your-site.com.`,

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

  /** @param {string} feature */
  noApiKey: (feature) =>
    [
      `${feature} needs an AI provider, and none is configured.`,
      ``,
      `OpenGEO is bring-your-own-key, and it does not care whose. Set one up with:`,
      `  opengeo settings`,
      ``,
      `Or add it to .env yourself:`,
      `  OPENGEO_PROVIDER=anthropic`,
      `  OPENGEO_API_KEY=sk-...`,
      ``,
      `Providers OpenGEO ships with:`,
      ...wrapList(AI_PROVIDERS, 68).map((line) => `  ${line}`),
      ``,
      `\`ollama\` runs on this machine and needs no key at all. \`custom\` points at any endpoint`,
      `speaking the OpenAI, Anthropic or Gemini shape: set ai.baseUrl and ai.model in`,
      `opengeo.config.json, or run \`opengeo settings\` and pick "something else".`,
      ``,
      `Only these need a key: generate's AI tier, and \`opengeo test --content\`.`,
      `Structural tests, generate's free tier, and opengeo-prod never need one.`,
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
      `An endpoint OpenGEO does not ship with has to be described before it can be called. In`,
      `opengeo.config.json:`,
      ``,
      `  "ai": {`,
      `    "provider": "${provider}",`,
      `    "model": "the model id your endpoint expects",`,
      `    "baseUrl": "https://your-endpoint.example.com/v1",`,
      `    "api": "openai"`,
      `  }`,
      ``,
      `"api" is the wire format that endpoint speaks: openai, anthropic or gemini.`,
      `\`opengeo settings\` asks for all of it if you would rather answer questions.`,
    ].join('\n'),

  /**
   * The provider refused the key or the account on one document, so the rest were never sent:
   * each would have failed the same way, and some providers bill or rate-limit refused calls.
   *
   * @param {number} status
   * @param {number} notSent
   */
  contentReviewHalted: (status, notSent) =>
    [
      `The provider refused the request with ${status}, so the content review stopped and ${notSent} document${notSent === 1 ? ' was' : 's were'} not sent.`,
      `That is almost always the API key or the account it belongs to. Check it with \`opengeo settings\` and run again.`,
    ].join('\n'),

  contentDocumentNotSent: 'Not sent: the provider refused an earlier document, so this one would have failed the same way.',

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
    `${file} already exists and OpenGEO did not write it, so it was left alone and the twin went to ${file}.opengeo-proposed. Add generated_by: manual to its frontmatter to serve yours, or use --force to replace it.`,

  /** @param {string} file */
  wouldOverwrite: (file) =>
    [
      `${file} already exists and wasn't written by OpenGEO - leaving it alone.`,
      ``,
      `A hand-written file here often carries intentional rules a blind overwrite would erase.`,
      `OpenGEO wrote its proposed version to ${file}.opengeo-proposed instead, so you can diff and`,
      `merge whatever you actually want.`,
      ``,
      `To overwrite for real: opengeo generate <url> --force`,
    ].join('\n'),

  /** @param {string} dir */
  noGeneratedOutput: (dir) =>
    [
      `No generated markdown found in ${dir}.`,
      ``,
      `Run \`opengeo generate <url>\` first - prod only ever serves files that already exist on disk.`,
    ].join('\n'),

  /**
   * @param {string} provider
   * @param {string[]} supported
   */
  unknownProvider: (provider, supported) =>
    [
      `Unknown AI provider "${provider}". OpenGEO supports:`,
      ...wrapList(supported, 68).map((line) => `  ${line}`),
      ``,
      `If yours is not on that list it is still supported: pick "custom", give it a baseUrl and a`,
      `model, and OpenGEO will talk to it. No code change, no waiting for a release.`,
    ].join('\n'),

  /**
   * Names both providers and never the key itself.
   *
   * @param {AiProvider} provider
   * @param {AiProvider} keyProvider
   */
  keyForOtherProvider: (provider, keyProvider) => {
    const native = providerInfo(provider).envVars[0];
    return [
      `The ${provider} provider was asked for, but the only key OpenGEO found belongs to ${keyProvider}, so`,
      `nothing was sent. A key only ever goes to the provider that issued it.`,
      ``,
      `To use ${provider}, give it its own key in .env:`,
      ...(native ? [`  ${native}=...`, `or:`] : []),
      `  OPENGEO_PROVIDER=${provider}`,
      `  OPENGEO_API_KEY=...`,
      ``,
      `Or run \`opengeo settings\` and pick ${provider}.`,
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
      `They ship in the opengeo package's web/ folder, so reinstalling opengeo puts them back. There is`,
      `nothing to build: in a clone they are packages/opengeo/web as checked out. --web <dir> points the`,
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
      `The details are in the terminal running \`opengeo start\`. They stay there rather than being`,
      `sent to the browser, because they can carry file paths from this machine.`,
    ].join('\n'),

  aiViaConfigRefused: () =>
    [
      `The AI provider cannot be changed through /api/config.`,
      ``,
      `Use the AI provider card in Settings, which posts to /api/key, or run \`opengeo settings\`.`,
      `Both save the provider, endpoint and key together and check them first, so a stored key is`,
      `never pointed at a host nobody typed it for.`,
    ].join('\n'),

  /** @param {string | undefined} host */
  hostRefused: (host) =>
    [
      `Refused: this dashboard only answers to the address it was started on, and the request was`,
      `addressed to ${host === undefined ? 'no host at all' : `"${host}"`}.`,
      ``,
      `Open the URL that \`opengeo start\` printed. A page reaching this server under any other name`,
      `is how a website tries to talk to a local server through DNS rebinding.`,
    ].join('\n'),

  tokenRequired: () =>
    [
      `Refused: this dashboard is reachable from the network, so every request needs the token it was`,
      `started with, and this one had none or the wrong one.`,
      ``,
      `Open the full URL that \`opengeo start\` printed, including ?token=. The token changes every time`,
      `the dashboard starts, so a URL from an earlier launch no longer works.`,
    ].join('\n'),

  /**
   * @param {string} provider
   * @param {number} status
   * @param {string | null} location
   */
  providerRedirected: (provider, status, location) =>
    [
      `The ${provider} API answered ${status} with a redirect${location ? ` to ${redirectHost(location)}` : ''}, and OpenGEO does not follow it.`,
      `A redirect would send your key to a host you did not configure. If the endpoint moved, put`,
      `its new address in ai.baseUrl in opengeo.config.json.`,
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

  /** @param {string} why */
  aiFallbackCached: (why) =>
    `Source unchanged since the last run, when the AI tier kept the algorithmic version (${why}). Not sent to the model again; --force retries it.`,

  /** @param {string} message */
  pageCrashed: (message) => `Could not generate this page: ${message}. The rest of the run carried on.`,

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

  siteUnreachableKept:
    'No page could be fetched, so the manifest was kept as it was and every existing twin is still served. Start the site and run generate again.',

  /** @param {string} origin */
  loopbackPublicOrigin: (origin) =>
    `sitemap.xml, robots.txt, llms.txt and every twin point at ${origin}, which only this machine can reach. Deployed like this, they send crawlers and agents nowhere. Set "publicOrigin" in opengeo.config.json to where the site is deployed, e.g. "https://example.com", and run generate again.`,

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

  /**
   * Takes the place of "Nothing was written." when setup or settings stops after it already had.
   *
   * @param {string[]} files
   */
  stoppedAfterWriting: (files) => `Already written before that, and left as it is: ${files.join(', ')}.`,

  /**
   * @param {string} provider
   * @param {number} status
   * @param {string} body
   */
  providerFailed: (provider, status, body) =>
    [
      `The ${provider} API returned ${status}.`,
      `  ${body.slice(0, 400)}`,
      ``,
      `Nothing was written. Your existing files are untouched.`,
    ].join('\n'),
});
