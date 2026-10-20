import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The folder a project's framework serves from the site root, read off `package.json`.
 *
 * A `next` in `package.json` is a statement about where static files go. It is what onboarding
 * offers as the web root, and what a project with no config file uses, so that generate writes the
 * twins where the framework serves them and test and prod look for them in the same place.
 *
 * `when` names a directory that has to exist for the rule to apply, for the frameworks whose
 * convention depends on the version or the layout rather than on the dependency alone.
 *
 * @type {ReadonlyArray<{ dep: RegExp; dir: string; why: string; when?: string }>}
 */
const BY_DEPENDENCY = [
  { dep: /^next$/, dir: 'public', why: 'Next.js serves public/ from the site root' },
  { dep: /^gatsby$/, dir: 'static', why: 'Gatsby serves static/ from the site root' },
  { dep: /^@sveltejs\/kit$/, dir: 'static', why: 'SvelteKit serves static/ from the site root' },
  { dep: /^nuxt$/, dir: 'public', why: 'Nuxt serves public/ from the site root' },
  { dep: /^astro$/, dir: 'public', why: 'Astro serves public/ from the site root' },
  { dep: /^@docusaurus\/core$/, dir: 'static', why: 'Docusaurus serves static/ from the site root' },
  { dep: /^(@react-router\/dev|@remix-run\/dev)$/, dir: 'public', why: 'React Router and Remix serve public/ from the site root' },
  // Angular 17 and later put public/ in angular.json's assets. Before that it was src/assets/,
  // served under /assets/, which cannot hold a robots.txt, so an older app gets no answer here.
  { dep: /^@angular\/core$/, dir: 'public', when: 'public', why: 'Angular serves public/ from the site root' },
  { dep: /^(@builder\.io\/qwik-city|@qwik\.dev\/router)$/, dir: 'public', why: 'Qwik City serves public/ from the site root' },
  { dep: /^@solidjs\/start$/, dir: 'public', why: 'SolidStart serves public/ from the site root' },
  { dep: /^(ember-source|ember-cli)$/, dir: 'public', why: 'Ember serves public/ from the site root' },
  // VitePress serves the public/ inside its source folder, usually docs/ beside docs/.vitepress.
  { dep: /^vitepress$/, dir: 'docs/public', when: 'docs/.vitepress', why: 'VitePress serves docs/public/ from the site root' },
  { dep: /^vitepress$/, dir: 'public', when: '.vitepress', why: 'VitePress serves public/ from the site root' },
  { dep: /^(vite|react-scripts|@vue\/cli-service)$/, dir: 'public', why: 'Vite serves public/ from the site root' },
];

/**
 * @param {string} root
 * @returns {{ dir: string; why: string } | undefined} Undefined when no framework it knows is a
 *   dependency, which is most plain sites and every project without a `package.json`.
 */
export function frameworkWebRoot(root) {
  const deps = readDependencies(root);
  if (deps.length === 0) return undefined;
  for (const candidate of BY_DEPENDENCY) {
    if (!deps.some((name) => candidate.dep.test(name))) continue;
    if (candidate.when && !isDirectory(join(root, candidate.when))) continue;
    return { dir: candidate.dir, why: candidate.why };
  }
  return undefined;
}

/**
 * Every dependency name in `package.json`, or none if there is no readable one.
 *
 * @param {string} root
 * @returns {string[]}
 */
function readDependencies(root) {
  try {
    const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
    /** @type {string[]} */
    const names = [];
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const block = parsed[field];
      if (block && typeof block === 'object') names.push(...Object.keys(/** @type {Record<string, unknown>} */ (block)));
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isDirectory(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
