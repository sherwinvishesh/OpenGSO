/**
 * Every user-facing error string in OpenGEO lives here (§13).
 *
 * One shared module, imported by all five published packages, so wording only ever changes in one
 * place and a limited install can tell the user exactly which package to reach for instead.
 */

export type CommandName = 'test' | 'generate' | 'setup' | 'start' | 'prod test';

/** Which published packages actually ship each command (§10). */
export const COMMAND_PACKAGES: Record<CommandName, string[]> = {
  test: ['opengeo', 'opengeo-cli', 'opengeo-testing'],
  generate: ['opengeo', 'opengeo-cli', 'opengeo-generate'],
  setup: ['opengeo', 'opengeo-cli'],
  start: ['opengeo'],
  'prod test': ['opengeo', 'opengeo-cli', 'opengeo-prod'],
};

export const COMMAND_BLURB: Record<CommandName, string> = {
  test: 'scores a live URL 0-100 for AI-readiness',
  generate: 'writes the .md twins, robots.txt, llms.txt and sitemap.xml',
  setup: 'walks you through project, API key and bot settings',
  start: 'launches the local OpenGEO dashboard in your browser',
  'prod test': 'verifies a deployed opengeo-prod middleware is serving correctly',
};

/** The narrowest package that ships a given command, for the "install just this" suggestion. */
export const NARROWEST_PACKAGE: Record<CommandName, string> = {
  test: 'opengeo-testing',
  generate: 'opengeo-generate',
  setup: 'opengeo-cli',
  start: 'opengeo',
  'prod test': 'opengeo-prod',
};

/**
 * Three of the five commands are pillars (§2). `setup` and `start` are not, and calling
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
 * package that ships `setup`. Both cases used to recommend a package that would not have helped.
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
      `${feature} needs an AI provider API key, and none is configured.`,
      ``,
      `OpenGEO is bring-your-own-key. Set one up with:`,
      `  opengeo setup`,
      ``,
      `Or add it to .env yourself:`,
      `  OPENGEO_PROVIDER=anthropic       # anthropic | openai | gemini`,
      `  OPENGEO_API_KEY=sk-...`,
      ``,
      `Only these need a key: generate's AI tier, and \`opengeo test --quality\`.`,
      `Structural tests, generate's free tier, and opengeo-prod never need one.`,
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
    `Unknown AI provider "${provider}". OpenGEO supports: ${supported.join(', ')}.`,

  providerFailed: (provider: string, status: number, body: string) =>
    [
      `The ${provider} API returned ${status}.`,
      `  ${body.slice(0, 400)}`,
      ``,
      `Nothing was written. Your existing files are untouched.`,
    ].join('\n'),
} as const;
