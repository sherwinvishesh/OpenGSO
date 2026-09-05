/** Tiny ANSI helper. A colour library would be a dependency for something that is 20 lines. */
const ESC = String.fromCharCode(27) + '[';

const enabled = (): boolean => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout && process.stdout.isTTY);
};

const wrap = (open: number, close: number) => (s: string) =>
  enabled() ? `${ESC}${open}m${s}${ESC}${close}m` : s;

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export const SYM = {
  pass: () => c.green('PASS'),
  fail: () => c.red('FAIL'),
  warn: () => c.yellow('WARN'),
  na: () => c.gray(' n/a'),
};

export function heading(text: string): string {
  return `\n${c.bold(text)}\n${c.gray('-'.repeat(Math.max(text.length, 8)))}`;
}
