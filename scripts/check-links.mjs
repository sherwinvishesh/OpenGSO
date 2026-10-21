#!/usr/bin/env node
/**
 * Every link between files in this repository lands.
 *
 * Three kinds of link are followed: a relative one in any tracked Markdown file, one into this
 * repository on GitHub (how the package READMEs reach docs/, because npmjs.com renders a README's
 * relative links against itself), and one to the project site, which is the website/ folder. Each
 * must name a tracked file, and one with a fragment must name a heading or an id in that file.
 * Nothing on any other host is fetched: this runs on every push and cannot depend on the network.
 *
 * Headings become anchors the way GitHub makes them: lowercased, punctuation dropped, spaces to
 * hyphens, and a repeated heading numbered from -1.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const REPO_FILE = /^https:\/\/github\.com\/sherwinvishesh\/OpenGSO\/(?:blob|tree)\/main\/([^#?]*)(#.*)?$/;
const SITE_FILE = /^https:\/\/sherwinvishesh\.github\.io\/OpenGSO\/([^#?]*)(?:\?[^#]*)?(#.*)?$/;

const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean));
const markdownFiles = [...tracked].filter((file) => file.endsWith('.md')).sort();

/** @type {Map<string, Set<string>>} */
const anchorsByFile = new Map();
/** @type {string[]} */
const failures = [];
let checked = 0;
let external = 0;

for (const file of markdownFiles) {
  for (const { line, target } of linksIn(readFileSync(join(root, file), 'utf8'))) {
    const where = `${file}:${line}`;
    const resolved = resolve(file, target);
    if (resolved === undefined) {
      external += 1;
      continue;
    }
    checked += 1;
    const { path, fragment } = resolved;
    const found = existing(path);
    if (!found) {
      failures.push(`${where}: ${target} -> ${path} is not a tracked file`);
      continue;
    }
    if (!fragment || /^#L\d+(?:-L\d+)?$/.test(fragment)) continue;
    const anchors = anchorsIn(found);
    if (!anchors) failures.push(`${where}: ${target} has a fragment, but ${found} is not a file with anchors`);
    else if (!anchors.has(decodeURIComponent(fragment.slice(1)))) failures.push(`${where}: ${target} -> no heading or id "${fragment.slice(1)}" in ${found}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log(`ok  ${checked} links land across ${markdownFiles.length} Markdown files (${external} to other hosts, not fetched)`);

/**
 * Every link destination in a Markdown document, with its line. Fenced code, inline code and HTML
 * comments are text, not links, so they are blanked first, line by line so the numbers hold.
 *
 * @param {string} markdown
 * @returns {{ line: number; target: string }[]}
 */
function linksIn(markdown) {
  const lines = markdown.split('\n');
  let fence = '';
  let inComment = false;
  const visible = lines.map((raw) => {
    let line = raw;
    if (inComment) {
      const end = line.indexOf('-->');
      if (end === -1) return '';
      line = line.slice(end + 3);
      inComment = false;
    }
    const opening = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (opening && opening[1].startsWith(fence[0]) && opening[1].length >= fence.length) fence = '';
      return '';
    }
    if (opening) {
      fence = opening[1];
      return '';
    }
    line = line.replace(/<!--[\s\S]*?-->/g, '');
    const start = line.indexOf('<!--');
    if (start !== -1) {
      line = line.slice(0, start);
      inComment = true;
    }
    return line.replace(/`[^`]*`/g, '');
  });

  /** @type {{ line: number; target: string }[]} */
  const links = [];
  visible.forEach((line, index) => {
    const push = (/** @type {string} */ target) => {
      if (target) links.push({ line: index + 1, target });
    };
    for (const match of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) push(match[1] ?? '');
    const definition = /^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/.exec(line);
    if (definition) push(definition[1] ?? '');
    for (const match of line.matchAll(/<(?:a|img|link)\s[^>]*?(?:href|src)=["']([^"']+)["']/g)) push(match[1] ?? '');
  });
  return links;
}

/**
 * The repository path a link names, or undefined for a link to another host, a mailbox or a phone.
 *
 * @param {string} from The Markdown file the link is in.
 * @param {string} target
 * @returns {{ path: string; fragment: string } | undefined}
 */
function resolve(from, target) {
  if (/^(?:mailto|tel|javascript):/i.test(target)) return undefined;
  const repo = REPO_FILE.exec(target);
  if (repo) return { path: posix.normalize(repo[1] ?? '').replace(/\/$/, ''), fragment: repo[2] ?? '' };
  const site = SITE_FILE.exec(target);
  if (site) return { path: sitePath(site[1] ?? ''), fragment: site[2] ?? '' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return undefined;
  const [withoutFragment = '', ...rest] = target.split('#');
  const fragment = rest.length > 0 ? `#${rest.join('#')}` : '';
  const pathPart = withoutFragment.split('?')[0] ?? '';
  if (pathPart === '') return { path: from, fragment };
  const base = pathPart.startsWith('/') ? pathPart.slice(1) : posix.join(posix.dirname(from), pathPart);
  return { path: posix.normalize(decodeURIComponent(base)).replace(/\/$/, ''), fragment };
}

/**
 * The file GitHub Pages serves for a path on the project site: a folder's index.html, else the file.
 *
 * @param {string} path
 * @returns {string}
 */
function sitePath(path) {
  const inside = decodeURIComponent(path);
  if (inside === '' || inside.endsWith('/')) return posix.join('website', inside, 'index.html');
  return posix.join('website', inside);
}

/**
 * The tracked file a path names: itself, or the README of a folder, since that is what GitHub shows
 * for a link to a folder. A folder with no README is still a landing, and is returned as the folder.
 *
 * @param {string} path
 * @returns {string | undefined}
 */
function existing(path) {
  if (tracked.has(path)) return path;
  if (path === '' || path === '.') return 'README.md';
  const readme = posix.join(path, 'README.md');
  if (tracked.has(readme)) return readme;
  for (const file of tracked) if (file.startsWith(`${path}/`)) return path;
  return undefined;
}

/**
 * Every anchor a file offers, or undefined for a file that cannot have one.
 *
 * @param {string} file
 * @returns {Set<string> | undefined}
 */
function anchorsIn(file) {
  const cached = anchorsByFile.get(file);
  if (cached) return cached;
  const isMarkdown = file.endsWith('.md');
  if (!isMarkdown && !/\.html?$/.test(file)) return undefined;
  const text = readFileSync(join(root, file), 'utf8');
  const anchors = new Set();
  for (const match of text.matchAll(/\s(?:id|name)=["']([^"']+)["']/g)) anchors.add(match[1] ?? '');
  if (isMarkdown) {
    /** @type {Map<string, number>} */
    const seen = new Map();
    let fence = '';
    for (const line of text.split('\n')) {
      const opening = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (opening && opening[1].startsWith(fence[0]) && opening[1].length >= fence.length) fence = '';
        continue;
      }
      if (opening) {
        fence = opening[1];
        continue;
      }
      const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (!heading) continue;
      const slug = githubSlug(heading[1] ?? '');
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      anchors.add(count === 0 ? slug : `${slug}-${count}`);
    }
  }
  anchorsByFile.set(file, anchors);
  return anchors;
}

/**
 * The anchor GitHub gives a heading, from its rendered text: code spans and links contribute
 * their text, emphasis markers are punctuation and go.
 *
 * @param {string} heading
 * @returns {string}
 */
function githubSlug(heading) {
  const text = heading
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  return text
    .toLowerCase()
    .trim()
    .replace(/[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
    .replace(/\s/g, '-');
}
