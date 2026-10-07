import { ERRORS } from '../shared/errors.js';

/**
 * A small argv parser, so the CLI has no runtime dependency for something this small.
 *
 * Supports `--flag`, `--key value`, `--key=value`, single-dash aliases, `--` to stop parsing (what
 * follows is positional), and positionals in any position.
 */

/**
 * @typedef {object} ArgSpec
 * @property {readonly string[]} [booleans] Options that never take a value.
 * @property {readonly string[]} [strings] Options that always take a value.
 * @property {Readonly<Record<string, NumberRule>>} [numbers] Options that take a number, and the range
 *   it has to be in. Each is value-taking, whether or not it is also listed in `strings`.
 * @property {Readonly<Record<string, string>>} [alias] Short name -> long name, e.g. `{ p: 'port' }`.
 */

/**
 * @typedef {object} NumberRule
 * @property {number} min
 * @property {number} [max]
 * @property {boolean} [integer]
 * @property {boolean} [exclusive] `min` itself is not allowed, e.g. a timeout above 0.
 */

export class Args {
  /** @readonly @type {readonly string[]} */
  positionals;
  /** @private @readonly @type {ReadonlyMap<string, string | boolean>} */
  values;
  /** @readonly @type {readonly string[]} */
  rest;
  /** @private @readonly @type {ReadonlySet<string>} */
  known;
  /** @private @readonly @type {ReadonlySet<string>} */
  missing;
  /** @private @readonly @type {Readonly<Record<string, NumberRule>>} */
  numbers;

  /**
   * @param {readonly string[]} positionals
   * @param {ReadonlyMap<string, string | boolean>} values
   * @param {readonly string[]} rest
   * @param {ReadonlySet<string>} known
   * @param {ReadonlySet<string>} [missing] Value-taking options that were given no value at all.
   * @param {Readonly<Record<string, NumberRule>>} [numbers]
   */
  constructor(positionals, values, rest, known, missing = new Set(), numbers = {}) {
    this.positionals = positionals;
    this.values = values;
    this.rest = rest;
    this.known = known;
    this.missing = missing;
    this.numbers = numbers;
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.values.has(name);
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  bool(name) {
    const value = this.values.get(name);
    if (value === undefined) return false;
    if (typeof value === 'boolean') return value;
    return value !== 'false' && value !== '0';
  }

  /**
   * @param {string} name
   * @returns {string | undefined}
   */
  str(name) {
    const value = this.values.get(name);
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * @param {string} name
   * @returns {number | undefined}
   */
  num(name) {
    const value = this.str(name);
    // `Number('')` is 0, which is how a bare `--port` used to bind a random port.
    if (value === undefined || value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  /**
   * Option names the command never declared, so the CLI can say "unknown flag" instead of ignoring.
   *
   * @returns {string[]}
   */
  unknown() {
    return [...this.values.keys()].filter((name) => !this.known.has(name));
  }

  /**
   * Everything wrong with the command line, as the message to print, or undefined when nothing is.
   * Unknown options, a value-taking option given no value, and a number that is not one or is out
   * of range are all refused here, so no command quietly runs on a default the user did not pick.
   *
   * @returns {string | undefined}
   */
  problem() {
    const unknown = this.unknown();
    if (unknown.length > 0) return ERRORS.unknownOptions(unknown.map((name) => `--${name}`));
    /** @type {string[]} */
    const problems = [];
    for (const name of this.values.keys()) {
      if (this.missing.has(name)) {
        problems.push(ERRORS.optionNeedsValue(`--${name}`));
        continue;
      }
      const rule = this.numbers[name];
      const value = this.str(name);
      if (rule && value !== undefined && !fitsRule(value, rule)) {
        problems.push(ERRORS.optionNotInRange(`--${name}`, value, rule));
      }
    }
    return problems.length > 0 ? problems.join('\n') : undefined;
  }
}

/**
 * Plain decimal digits only. `Number()` would also take `0x50`, `1e3` and padding, none of which
 * anybody means as a port or a page count.
 *
 * @param {string} value
 * @param {NumberRule} rule
 * @returns {boolean}
 */
function fitsRule(value, rule) {
  if (!(rule.integer ? /^\d+$/ : /^\d+(\.\d+)?$/).test(value)) return false;
  const parsed = Number(value);
  if (rule.exclusive ? parsed <= rule.min : parsed < rule.min) return false;
  return rule.max === undefined || parsed <= rule.max;
}

/**
 * @param {readonly string[]} argv
 * @param {ArgSpec} [spec]
 * @returns {Args}
 */
export function parseArgs(argv, spec = {}) {
  /** @type {ReadonlySet<string>} */
  const booleans = new Set(spec.booleans ?? []);
  const numbers = spec.numbers ?? {};
  const strings = new Set([...(spec.strings ?? []), ...Object.keys(numbers)]);
  const alias = spec.alias ?? {};

  /** @type {string[]} */
  const positionals = [];
  /** @type {Map<string, string | boolean>} */
  const values = new Map();
  /** @type {string[]} */
  const rest = [];
  /** @type {Set<string>} */
  const missing = new Set();

  for (let i = 0; i < argv.length; i += 1) {
    const token = /** @type {string} */ (argv[i]);

    if (token === '--') {
      rest.push(...argv.slice(i + 1));
      positionals.push(...rest);
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }

    const withoutDashes = token.replace(/^--?/, '');
    const eq = withoutDashes.indexOf('=');
    const rawName = eq === -1 ? withoutDashes : withoutDashes.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : withoutDashes.slice(eq + 1);
    const name = alias[rawName] ?? rawName;

    if (inlineValue !== undefined) {
      values.set(name, inlineValue);
      if (inlineValue === '' && strings.has(name)) missing.add(name);
      continue;
    }
    if (strings.has(name)) {
      const next = argv[i + 1];
      if (next !== undefined && (!next.startsWith('-') || next === '-')) {
        values.set(name, next);
        i += 1;
        continue;
      }
      // Declared as taking a value but given none: recorded as present, and `problem()` refuses it
      // rather than letting the command silently use a default.
      values.set(name, '');
      missing.add(name);
      continue;
    }
    values.set(name, true);
  }

  return new Args(positionals, values, rest, new Set([...booleans, ...strings]), missing, numbers);
}
