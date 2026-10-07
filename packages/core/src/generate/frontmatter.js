/**
 * Minimal YAML frontmatter, deliberately not a YAML library.
 *
 * OpenGEO only ever writes a flat map of strings, numbers, booleans and string arrays, and only
 * ever reads back frontmatter it wrote. A full YAML parser would be a dependency in every published
 * package for a feature this small.
 */
/** @typedef {string | number | boolean | string[]} FrontmatterValue */
/** @typedef {Record<string, FrontmatterValue>} Frontmatter */

/**
 * Fields:
 * - `last_updated`: ISO timestamp. The staleness signal test reads and the product UI surfaces (§6).
 * - `tokens`: Precomputed so prod never has to count anything at request time (§7).
 * - `source_hash`: Hash of the markdown extracted from the page, not of its raw HTML, which changes
 *   on every rebuild. Powers caching and drift detection; see ManifestEntry.sourceHash.
 * - `generated_by`: Which tier produced it. A hand-edited file can be marked by setting this to
 *   "manual".
 *
 * @typedef {Frontmatter & {
 *   title: string;
 *   url: string;
 *   last_updated: string;
 *   tokens: number;
 *   source_hash: string;
 *   generated_by: string;
 * }} PageFrontmatter
 */

/**
 * @param {Frontmatter} data
 * @returns {string}
 */
export function serializeFrontmatter(data) {
  const lines = Object.entries(data).map(([key, value]) => `${key}: ${serializeValue(value)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

/**
 * @param {FrontmatterValue} value
 * @returns {string}
 */
function serializeValue(value) {
  if (Array.isArray(value)) return `[${value.map((v) => quote(v)).join(', ')}]`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return quote(value);
}

/**
 * @param {string} value
 * @returns {string}
 */
function quote(value) {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * @typedef {object} ParsedDocument
 * @property {Frontmatter} data
 * @property {string} body
 * @property {boolean} hasFrontmatter
 */

/**
 * @param {string} source
 * @returns {ParsedDocument}
 */
export function parseFrontmatter(source) {
  const text = source.replace(/^﻿/, '');
  if (!text.startsWith('---')) return { data: {}, body: text, hasFrontmatter: false };

  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text, hasFrontmatter: false };

  const block = text.slice(text.indexOf('\n') + 1, end);
  const rest = text.slice(end + '\n---'.length).replace(/^[^\n]*\n?/, '');
  /** @type {Frontmatter} */
  const data = {};

  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    if (!key) continue;
    data[key] = parseValue(raw);
  }
  return { data, body: rest, hasFrontmatter: true };
}

/**
 * @param {string} raw
 * @returns {FrontmatterValue}
 */
function parseValue(raw) {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((part) => unquote(part.trim()));
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw)) && !/^["']/.test(raw)) return Number(raw);
  return unquote(raw);
}

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return value;
}

/**
 * Build the full `.md` file contents: frontmatter block plus body.
 *
 * @param {Frontmatter} data
 * @param {string} body
 * @returns {string}
 */
export function withFrontmatter(data, body) {
  return `${serializeFrontmatter(data)}\n${body.trim()}\n`;
}
