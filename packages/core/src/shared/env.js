import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './fs.js';
import { join } from 'node:path';
import { ERRORS } from './errors.js';
import { PROVIDERS, isAiProvider, providerInfo } from './providers.js';

/** @import { AiProvider } from './providers.js' */

/**
 * API key handling (§11).
 *
 * The key is read from a local `.env` and nowhere else. It is never written to
 * opengeo.config.json (which people commit), never sent anywhere but the user's chosen AI provider,
 * and `.env` is force-added to `.gitignore` during setup - that gitignore line is the actual
 * mechanism that prevents an accidental leak, so it is not optional.
 */

export const ENV_FILENAME = '.env';
export const KEY_VAR = 'OPENGEO_API_KEY';
export const PROVIDER_VAR = 'OPENGEO_PROVIDER';
export const MODEL_VAR = 'OPENGEO_MODEL';
/**
 * Only meaningful for an endpoint OpenGEO does not ship: a gateway, a proxy, a self-hosted server.
 * It lives beside the key rather than in the config file because the two are usually issued
 * together, and because a private hostname is closer to a secret than to a project setting.
 */
export const BASE_URL_VAR = 'OPENGEO_BASE_URL';

/**
 * A leading `export ` is what lets the same file be `source`d by a shell, and every dotenv reader
 * accepts it. Without this the key was read as a variable literally named `export OPENGEO_API_KEY`.
 */
const EXPORT_PREFIX = /^export\s+/;

/**
 * The variable a line assigns, or undefined for a blank line, a comment, or anything else.
 *
 * @param {string} rawLine
 * @returns {{ key: string; value: string; exported: boolean } | undefined}
 */
function assignment(rawLine) {
  let line = rawLine.trim();
  if (!line || line.startsWith('#')) return undefined;
  const exported = EXPORT_PREFIX.test(line);
  if (exported) line = line.replace(EXPORT_PREFIX, '');
  const eq = line.indexOf('=');
  if (eq === -1) return undefined;
  const key = line.slice(0, eq).trim();
  return key ? { key, value: line.slice(eq + 1).trim(), exported } : undefined;
}

/**
 * The value as dotenv readers see it. A quoted value ends at its closing quote, so a `#` inside it
 * is kept and a comment after it is not. An unquoted value ends where a `#` follows whitespace: the
 * docs show `OPENGEO_BASE_URL=https://... # optional`, and the comment used to land in the URL. A
 * `#` with no space before it is kept, so a key that happens to contain one still reads whole.
 *
 * @param {string} raw
 * @returns {string}
 */
function unquote(raw) {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const close = raw.indexOf(quote, 1);
    if (close > 0 && /^\s*(#.*)?$/.test(raw.slice(close + 1))) return raw.slice(1, close);
    return raw.length > 1 && raw.endsWith(quote) ? raw.slice(1, -1) : raw;
  }
  if (raw.startsWith('#')) return '';
  return raw.replace(/\s+#.*$/, '');
}

/**
 * @param {string} contents
 * @returns {Record<string, string>}
 */
export function parseEnv(contents) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const rawLine of contents.split('\n')) {
    const parsed = assignment(rawLine);
    if (!parsed) continue;
    const key = parsed.key;
    out[key] = unquote(parsed.value);
  }
  return out;
}

/**
 * @param {string} root
 * @returns {Record<string, string>}
 */
export function readEnvFile(root) {
  const path = join(root, ENV_FILENAME);
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, 'utf8'));
}

/**
 * @typedef {object} Credentials
 * @property {AiProvider} provider
 * @property {string} apiKey
 * @property {string} [model]
 * @property {string} [baseUrl] Set only when `.env` names an endpoint, which is how a self-hosted
 *   provider is configured.
 * @property {'env-file' | 'process-env'} source Where the key came from, so the UI and CLI can tell
 *   the user exactly where it lives.
 * @property {boolean} [keyless] True for a provider that needs no key at all, where an empty
 *   `apiKey` is the correct answer.
 */

/**
 * Every provider-native variable the catalogue accepts, flattened in picker order.
 *
 * Derived rather than written out: a provider added to the catalogue without a matching entry here
 * would silently ignore the key the user already had exported, and nobody would find out until they
 * filed a bug about it.
 *
 * @type {Array<[AiProvider, string]>}
 */
const NATIVE_KEY_VARS = PROVIDERS.flatMap((provider) =>
  provider.envVars.map((name) => /** @type {[AiProvider, string]} */ ([provider.id, name])),
);

/**
 * Resolve credentials from `.env`, falling back to the process environment. Also accepts the
 * provider-native variable names people already have exported, so nobody has to duplicate a key
 * they've already set up.
 *
 * @param {string} root
 * @returns {Credentials | undefined}
 */
export function readCredentials(root) {
  const fileEnv = readEnvFile(root);
  /** @param {string} name */
  const pick = (name) => pickVar(fileEnv, name);

  const explicit = pick(KEY_VAR);
  const providerVar = pick(PROVIDER_VAR);
  const providerRaw = providerVar?.value?.toLowerCase();
  const provider = isAiProvider(providerRaw) ? providerRaw : undefined;
  const model = pick(MODEL_VAR)?.value;
  const baseUrl = pick(BASE_URL_VAR)?.value;

  if (explicit) {
    return { provider: provider ?? 'anthropic', apiKey: explicit.value, model, baseUrl, source: explicit.source };
  }

  // A provider that needs no key is configured the moment it is named. Ollama is the case that
  // matters: requiring a placeholder key for a model running on the same machine would be theatre.
  if (provider && providerInfo(provider).keyless) {
    return { provider, apiKey: '', model, baseUrl, source: /** @type {NonNullable<typeof providerVar>} */ (providerVar).source, keyless: true };
  }

  for (const [nativeProvider, varName] of NATIVE_KEY_VARS) {
    if (provider && provider !== nativeProvider) continue;
    const found = pick(varName);
    if (found) return { provider: nativeProvider, apiKey: found.value, model, baseUrl, source: found.source };
  }
  return undefined;
}

/**
 * The key issued by one particular provider, under its own variable names only. `OPENGEO_API_KEY`
 * is not one of them: it belongs to whichever provider `OPENGEO_PROVIDER` names, and that is
 * `readCredentials`'s answer, not this one's.
 *
 * @param {string} root
 * @param {AiProvider} provider
 * @returns {{ value: string; source: Credentials['source'] } | undefined}
 */
export function readNativeKey(root, provider) {
  const fileEnv = readEnvFile(root);
  for (const name of providerInfo(provider).envVars) {
    const found = pickVar(fileEnv, name);
    if (found) return found;
  }
  return undefined;
}

/**
 * `.env` first, then the process environment.
 *
 * @param {Record<string, string>} fileEnv
 * @param {string} name
 * @returns {{ value: string; source: Credentials['source'] } | undefined}
 */
function pickVar(fileEnv, name) {
  if (fileEnv[name]) return { value: fileEnv[name], source: 'env-file' };
  const fromProcess = process.env[name];
  if (fromProcess) return { value: fromProcess, source: 'process-env' };
  return undefined;
}

/**
 * Set each variable in `.env`, or remove it when the value is `undefined`. Removal matters because
 * `.env` outranks the config: a base URL left behind by an earlier provider would quietly receive
 * the next provider's key.
 *
 * @param {string} root
 * @param {Record<string, string | undefined>} vars
 * @returns {string}
 */
export function writeEnvVars(root, vars) {
  const problem = envValueProblem(vars);
  if (problem) throw new Error(problem);
  const path = join(root, ENV_FILENAME);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const eol = lineEnding(existing);
  let lines = existing ? existing.replace(/(\r?\n)+$/, '').split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(vars)) {
    /** @param {string} line */
    const matches = (line) => assignment(line)?.key === key;
    const index = lines.findIndex(matches);
    if (value === undefined) {
      lines = lines.filter((line) => !matches(line));
      continue;
    }
    // A line the user wrote with export keeps it, so the file still works when sourced.
    const line = `${index >= 0 && assignment(lines[index])?.exported ? 'export ' : ''}${key}=${value}`;
    // Every later copy goes. The last assignment is the one a reader keeps, so updating only the
    // first copy of a duplicated key left the old value in force.
    lines = lines.filter((existingLine, i) => i === index || !matches(existingLine));
    if (index >= 0) lines[index] = line;
    else lines.push(line);
  }
  const output = `${lines.join(eol).replace(/(\r?\n)+$/, '')}${eol}`;
  // The mode only applies when the file is created. An existing .env keeps whatever its owner chose.
  writeFileAtomic(path, output, { mode: 0o600 });
  return path;
}

/**
 * The line ending a file already uses, so a line OpenGEO adds does not leave it with two. A file
 * written on Windows keeps CRLF; anything else, including a new file, gets LF.
 *
 * @param {string} text
 * @returns {'\r\n' | '\n'}
 */
function lineEnding(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Why these values cannot go into `.env`, or nothing if they can. A line break in a model name or a
 * pasted key would write a second variable, `OPENGEO_BASE_URL` included, so control characters are
 * refused outright rather than escaped into a syntax every dotenv reader parses differently.
 *
 * @param {Record<string, string | undefined>} vars
 * @returns {string | undefined}
 */
export function envValueProblem(vars) {
  for (const [name, value] of Object.entries(vars)) {
    if (value !== undefined && /[\u0000-\u001f\u007f]/.test(value)) return ERRORS.envValueRefused(name);
  }
  return undefined;
}

/**
 * @typedef {object} GitignoreResult
 * @property {string} path
 * @property {boolean} added
 * @property {boolean} alreadyPresent
 */

/**
 * Ensure `.env` is gitignored. Called before any key is ever written, on every path that writes one.
 *
 * @param {string} root
 * @returns {GitignoreResult}
 */
export function ensureEnvGitignored(root) {
  const path = join(root, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const present = existing
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l === '.env' || l === '/.env' || l === '.env*' || l === '*.env');
  if (present) return { path, added: false, alreadyPresent: true };
  const eol = lineEnding(existing);
  const prefix = existing && !existing.endsWith('\n') ? eol : '';
  appendFileSync(path, `${prefix}${eol}# Added by OpenGEO - never commit your API key${eol}.env${eol}`, 'utf8');
  return { path, added: true, alreadyPresent: false };
}

/**
 * Anything AI-touched is local-machine-only (§5, §6, §16). This is the enforcement point, not a
 * doc comment: generate's AI tier and `test --quality` both call it and refuse under CI.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isCI(env = process.env) {
  return [env.CI, env.CONTINUOUS_INTEGRATION, env.GITHUB_ACTIONS, env.GITLAB_CI, env.CIRCLECI, env.BUILDKITE].some(isSet);
}

/**
 * `CI=false` and `CI=0` are how people switch CI detection off, for a local run of a CI script or
 * a container that sets it by default. Reading any non-empty string as true refused the AI tier
 * there.
 *
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isSet(value) {
  const normal = value?.trim().toLowerCase();
  return Boolean(normal) && normal !== 'false' && normal !== '0';
}
