import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiProvider } from './config.js';
import { AI_PROVIDERS } from './config.js';

/**
 * API key handling (idea.md §11).
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

export function parseEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function readEnvFile(root: string): Record<string, string> {
  const path = join(root, ENV_FILENAME);
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, 'utf8'));
}

export interface Credentials {
  provider: AiProvider;
  apiKey: string;
  model?: string;
  /** Where the key came from, so the UI and CLI can tell the user exactly where it lives. */
  source: 'env-file' | 'process-env';
}

/**
 * Resolve credentials from `.env`, falling back to the process environment. Also accepts the
 * provider-native variable names people already have exported, so nobody has to duplicate a key
 * they've already set up.
 */
export function readCredentials(root: string): Credentials | undefined {
  const fileEnv = readEnvFile(root);
  const pick = (name: string): { value: string; source: Credentials['source'] } | undefined => {
    if (fileEnv[name]) return { value: fileEnv[name], source: 'env-file' };
    const fromProcess = process.env[name];
    if (fromProcess) return { value: fromProcess, source: 'process-env' };
    return undefined;
  };

  const explicit = pick(KEY_VAR);
  const providerRaw = pick(PROVIDER_VAR)?.value?.toLowerCase();
  const provider = AI_PROVIDERS.includes(providerRaw as AiProvider) ? (providerRaw as AiProvider) : undefined;
  const model = pick(MODEL_VAR)?.value;

  if (explicit) {
    return { provider: provider ?? 'anthropic', apiKey: explicit.value, model, source: explicit.source };
  }

  const native: Array<[AiProvider, string]> = [
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
    ['gemini', 'GEMINI_API_KEY'],
    ['gemini', 'GOOGLE_API_KEY'],
  ];
  for (const [nativeProvider, varName] of native) {
    if (provider && provider !== nativeProvider) continue;
    const found = pick(varName);
    if (found) return { provider: nativeProvider, apiKey: found.value, model, source: found.source };
  }
  return undefined;
}

export function writeEnvVars(root: string, vars: Record<string, string>): string {
  const path = join(root, ENV_FILENAME);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = existing ? existing.split('\n') : [];
  for (const [key, value] of Object.entries(vars)) {
    const index = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  const output = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  writeFileSync(path, output, 'utf8');
  return path;
}

export interface GitignoreResult {
  path: string;
  added: boolean;
  alreadyPresent: boolean;
}

/** Ensure `.env` is gitignored. Called by `opengeo setup` before any key is ever written. */
export function ensureEnvGitignored(root: string): GitignoreResult {
  const path = join(root, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const present = existing
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l === '.env' || l === '/.env' || l === '.env*' || l === '*.env');
  if (present) return { path, added: false, alreadyPresent: true };
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(path, `${prefix}\n# Added by opengeo setup - never commit your API key\n.env\n`, 'utf8');
  return { path, added: true, alreadyPresent: false };
}

/**
 * Anything AI-touched is local-machine-only (§5, §6, §16). This is the enforcement point, not a
 * doc comment: generate's AI tier and `test --quality` both call it and refuse under CI.
 */
export function isCI(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(
    env.CI || env.CONTINUOUS_INTEGRATION || env.GITHUB_ACTIONS || env.GITLAB_CI || env.CIRCLECI || env.BUILDKITE,
  );
}
