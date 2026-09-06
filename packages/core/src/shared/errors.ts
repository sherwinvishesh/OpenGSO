/**
 * Every user-facing error string in OpenGEO lives here (§13).
 *
 * One shared module, imported by all five published packages, so wording only ever changes in one
 * place and a limited install can tell the user exactly which package to reach for instead.
 */

import { AI_PROVIDERS, PROVIDERS, providerInfo } from './providers.js';

export type CommandName = 'test' | 'generate' | 'settings' | 'start' | 'prod test';

/** Which published packages actually ship each command (§10). */
export const COMMAND_PACKAGES: Record<CommandName, string[]> = {
  test: ['opengeo', 'opengeo-cli', 'opengeo-testing'],
  generate: ['opengeo', 'opengeo-cli', 'opengeo-generate'],
  settings: ['opengeo', 'opengeo-cli'],
  start: ['opengeo'],
  'prod test': ['opengeo', 'opengeo-cli', 'opengeo-prod'],
};

export const COMMAND_BLURB: Record<CommandName, string> = {
  test: 'scores a live URL 0-100 for AI-readiness',
  generate: 'writes the .md twins, robots.txt, llms.txt and sitemap.xml',
  settings: 'change the site, the bot lists and the API key, in your terminal',
  start: 'sets the project up, then opens the OpenGEO dashboard',
  'prod test': 'verifies a deployed opengeo-prod middleware is serving correctly',
};

/** The narrowest package that ships a given command, for the "install just this" suggestion. */
export const NARROWEST_PACKAGE: Record<CommandName, string> = {
  test: 'opengeo-testing',
  generate: 'opengeo-generate',
  settings: 'opengeo-cli',
  start: 'opengeo',
  'prod test': 'opengeo-prod',
};

/**
 * Three of the five commands are pillars (§2). `settings` and `start` are not, and calling
 * them one would make the error read as if written by someone who had never run the tool.
 */
const PILLAR_OF: Partial<Record<CommandName, string>> = {
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
 */
export function commandUnavailable(command: CommandName, installedPackage: string): string {
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

export function unknownCommand(command: string, available: CommandName[]): string {
  return [
    `Unknown command: \`opengeo ${command}\`.`,
    ``,
    available.length > 0
      ? `This install can run: ${available.map((c) => `opengeo ${c}`).join(', ')}.`
      : `This install ships no CLI commands.`,
    `Run \`opengeo --help\` for the full list.`,
  ].join('\n');
}

/** Wrap a comma-separated list at `width` so a long catalogue does not run off a terminal. */
function wrapList(items: readonly string[], width: number): string[] {
  const lines: string[] = [];
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

/** One line per provider, for `--help` and the settings screen. */
export function providerListing(): string[] {
  const width = Math.max(...PROVIDERS.map((provider) => provider.id.length));
  return PROVIDERS.map((provider) => {
    const info = providerInfo(provider.id);
    const suffix = info.keyless ? ' (no key, on this machine)' : info.userDefined ? ' (your own endpoint)' : '';
    return `${provider.id.padEnd(width + 2)}${info.label}${suffix}`;
  });
}

export const ERRORS = {
  missingUrl: (command: string) =>
    [
      `\`opengeo ${command}\` needs a URL.`,
      ``,
      `OpenGEO always works against a URL, never a source directory - it has to see what your site`,
      `actually serves over HTTP: real headers, real response, real rendering result.`,
      ``,
      `  opengeo ${command} http://localhost:3000`,
      `  opengeo ${command} https://your-site.com`,
    ].join('\n'),

  invalidUrl: (value: string) =>
    `"${value}" isn't a URL OpenGEO can fetch. Include the scheme, e.g. http://localhost:3000 or https://your-site.com.`,

  fetchFailed: (url: string, reason: string) =>
    [
      `Couldn't reach ${url}`,
      `  ${reason}`,
      ``,
      `If this is a local dev server, check it's running and on the port you expect.`,
    ].join('\n'),

  noApiKey: (feature: string) =>
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
   */
  providerIncomplete: (provider: string, missing: string[]) =>
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

  ciBlocked: (feature: string) =>
    [
      `${feature} is a local-machine-only feature and won't run in CI.`,
      ``,
      `This is deliberate: anything AI-touched gets a human review before it ships, rather than`,
      `silently regenerating unattended on every deploy.`,
      ``,
      `Run it on your own machine, review the result, and commit the output.`,
    ].join('\n'),

  wouldOverwrite: (file: string) =>
    [
      `${file} already exists and wasn't written by OpenGEO - leaving it alone.`,
      ``,
      `A hand-written file here often carries intentional rules a blind overwrite would erase.`,
      `OpenGEO wrote its proposed version to ${file}.opengeo-proposed instead, so you can diff and`,
      `merge whatever you actually want.`,
      ``,
      `To overwrite for real: opengeo generate <url> --force`,
    ].join('\n'),

  noGeneratedOutput: (dir: string) =>
    [
      `No generated markdown found in ${dir}.`,
      ``,
      `Run \`opengeo generate <url>\` first - prod only ever serves files that already exist on disk.`,
    ].join('\n'),

  unknownProvider: (provider: string, supported: string[]) =>
    [
      `Unknown AI provider "${provider}". OpenGEO supports:`,
      ...wrapList(supported, 68).map((line) => `  ${line}`),
      ``,
      `If yours is not on that list it is still supported: pick "custom", give it a baseUrl and a`,
      `model, and OpenGEO will talk to it. No code change, no waiting for a release.`,
    ].join('\n'),

  providerFailed: (provider: string, status: number, body: string) =>
    [
      `The ${provider} API returned ${status}.`,
      `  ${body.slice(0, 400)}`,
      ``,
      `Nothing was written. Your existing files are untouched.`,
    ].join('\n'),
} as const;
