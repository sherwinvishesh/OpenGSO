/**
 * Reading robots.txt the way a crawler does (RFC 9309).
 *
 * One implementation for both readers: the A1 check in `opengso test`, and the startup summary and
 * `prod test` in opengso-prod. Because prod imports it, it has no dependencies and no `node:`
 * modules, only string work.
 */

/**
 * @typedef {object} RobotsRule
 * @property {'allow' | 'disallow'} type
 * @property {string} path
 */

/**
 * Every group, keyed by lower-cased User-agent token. Consecutive User-agent lines share a group.
 *
 * @param {string} contents
 * @returns {Map<string, RobotsRule[]>}
 */
export function parseRobots(contents) {
  /** @type {Map<string, RobotsRule[]>} */
  const groups = new Map();
  /** @type {string[]} */
  let currentAgents = [];
  let expectingAgents = true;

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!expectingAgents) {
        currentAgents = [];
        expectingAgents = true;
      }
      currentAgents.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), []);
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      expectingAgents = false;
      for (const agent of currentAgents) {
        const list = groups.get(agent) ?? [];
        list.push({ type: field, path: value });
        groups.set(agent, list);
      }
    }
  }
  return groups;
}

/**
 * The rules a crawler obeys: its own group if there is one, the `*` group otherwise.
 *
 * A crawler with its own group ignores `*` entirely, even when its group is empty, which is why the
 * lookup is by presence and not by whether the group has rules.
 *
 * @param {Map<string, RobotsRule[]>} groups
 * @param {string} token
 * @returns {RobotsRule[] | undefined}
 */
export function robotsRulesFor(groups, token) {
  return groups.get(token.toLowerCase()) ?? groups.get('*');
}

/**
 * Whether `path` (path plus query) may be fetched under these rules.
 *
 * The longest matching rule wins, and an Allow wins a tie. `*` matches any run of characters and a
 * trailing `$` anchors the end. An empty Disallow matches nothing, which is how a file says "allow
 * everything".
 *
 * @param {readonly RobotsRule[]} rules
 * @param {string} path
 * @returns {boolean}
 */
export function robotsAllows(rules, path) {
  /** @type {RobotsRule | undefined} */
  let best;
  for (const rule of rules) {
    if (!rule.path || !matches(rule.path, path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.type === 'allow')) best = rule;
  }
  return best?.type !== 'disallow';
}

/**
 * @param {string} pattern
 * @param {string} path
 * @returns {boolean}
 */
function matches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}
