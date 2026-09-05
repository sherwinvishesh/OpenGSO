/**
 * Minimal YAML frontmatter, deliberately not a YAML library.
 *
 * OpenGEO only ever writes a flat map of strings, numbers, booleans and string arrays, and only
 * ever reads back frontmatter it wrote. A full YAML parser would be a dependency in every published
 * package for a feature this small.
 */
export type FrontmatterValue = string | number | boolean | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export interface PageFrontmatter extends Frontmatter {
  title: string;
  url: string;
  /** ISO timestamp. The staleness signal test reads and the product UI surfaces (§6). */
  last_updated: string;
  /** Precomputed so prod never has to count anything at request time (§7). */
  tokens: number;
  /** Hash of the source HTML this twin was generated from - powers caching and drift detection. */
  source_hash: string;
  /** Which tier produced it. A hand-edited file can be marked by setting this to "manual". */
  generated_by: string;
}

export function serializeFrontmatter(data: Frontmatter): string {
  const lines = Object.entries(data).map(([key, value]) => `${key}: ${serializeValue(value)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

function serializeValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) return `[${value.map((v) => quote(v)).join(', ')}]`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return quote(value);
}

function quote(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export interface ParsedDocument {
  data: Frontmatter;
  body: string;
  hasFrontmatter: boolean;
}

export function parseFrontmatter(source: string): ParsedDocument {
  const text = source.replace(/^﻿/, '');
  if (!text.startsWith('---')) return { data: {}, body: text, hasFrontmatter: false };

  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text, hasFrontmatter: false };

  const block = text.slice(text.indexOf('\n') + 1, end);
  const rest = text.slice(end + '\n---'.length).replace(/^[^\n]*\n?/, '');
  const data: Frontmatter = {};

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

function parseValue(raw: string): FrontmatterValue {
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

function unquote(value: string): string {
  if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return value;
}

/** Build the full `.md` file contents: frontmatter block plus body. */
export function withFrontmatter(data: Frontmatter, body: string): string {
  return `${serializeFrontmatter(data)}\n${body.trim()}\n`;
}
