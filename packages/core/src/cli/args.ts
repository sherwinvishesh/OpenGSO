/**
 * A ~90-line argv parser, so the CLI has no runtime dependency for something this small.
 *
 * Supports `--flag`, `--key value`, `--key=value`, single-dash aliases, `--` to stop parsing, and
 * positionals in any position.
 */

export interface ArgSpec {
  /** Options that never take a value. */
  booleans?: readonly string[];
  /** Options that always take a value. */
  strings?: readonly string[];
  /** Short name -> long name, e.g. `{ p: 'port' }`. */
  alias?: Readonly<Record<string, string>>;
}

export class Args {
  constructor(
    readonly positionals: readonly string[],
    private readonly values: ReadonlyMap<string, string | boolean>,
    readonly rest: readonly string[],
    private readonly known: ReadonlySet<string>,
  ) {}

  has(name: string): boolean {
    return this.values.has(name);
  }

  bool(name: string): boolean {
    const value = this.values.get(name);
    if (value === undefined) return false;
    if (typeof value === 'boolean') return value;
    return value !== 'false' && value !== '0';
  }

  str(name: string): string | undefined {
    const value = this.values.get(name);
    return typeof value === 'string' ? value : undefined;
  }

  num(name: string): number | undefined {
    const value = this.str(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  /** Option names the command never declared, so the CLI can say "unknown flag" instead of ignoring. */
  unknown(): string[] {
    return [...this.values.keys()].filter((name) => !this.known.has(name));
  }
}

export function parseArgs(argv: readonly string[], spec: ArgSpec = {}): Args {
  const booleans: ReadonlySet<string> = new Set(spec.booleans ?? []);
  const strings = new Set(spec.strings ?? []);
  const alias = spec.alias ?? {};

  const positionals: string[] = [];
  const values = new Map<string, string | boolean>();
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;

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
