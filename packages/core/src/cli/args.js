/**
 * A ~90-line argv parser, so the CLI has no runtime dependency for something this small.
 *
 * Supports `--flag`, `--key value`, `--key=value`, single-dash aliases, `--` to stop parsing, and
 * positionals in any position.
 */

/**
 * @typedef {object} ArgSpec
 * @property {readonly string[]} [booleans] Options that never take a value.
 * @property {readonly string[]} [strings] Options that always take a value.
 * @property {Readonly<Record<string, string>>} [alias] Short name -> long name, e.g. `{ p: 'port' }`.
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

  /**
   * @param {readonly string[]} positionals
   * @param {ReadonlyMap<string, string | boolean>} values
   * @param {readonly string[]} rest
   * @param {ReadonlySet<string>} known
   */
  constructor(positionals, values, rest, known) {
    this.positionals = positionals;
    this.values = values;
    this.rest = rest;
    this.known = known;
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
    if (value === undefined) return undefined;
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
}

/**
 * @param {readonly string[]} argv
 * @param {ArgSpec} [spec]
 * @returns {Args}
 */
export function parseArgs(argv, spec = {}) {
  /** @type {ReadonlySet<string>} */
  const booleans = new Set(spec.booleans ?? []);
  const strings = new Set(spec.strings ?? []);
  const alias = spec.alias ?? {};

  /** @type {string[]} */
  const positionals = [];
  /** @type {Map<string, string | boolean>} */
  const values = new Map();
  /** @type {string[]} */
  const rest = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = /** @type {string} */ (argv[i]);

    if (token === '--') {
      rest.push(...argv.slice(i + 1));
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
      continue;
    }
    if (strings.has(name)) {
      const next = argv[i + 1];
      if (next !== undefined && (!next.startsWith('-') || next === '-')) {
        values.set(name, next);
        i += 1;
        continue;
      }
      // Declared as taking a value but given none: record it as present so the command can
      // complain with a specific message instead of silently using a default.
      values.set(name, '');
      continue;
    }
    values.set(name, true);
  }

  return new Args(positionals, values, rest, new Set([...booleans, ...strings]));
}
