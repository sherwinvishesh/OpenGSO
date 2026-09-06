/**
 * Raw keystrokes, decoded.
 *
 * In raw mode stdin delivers bytes, not lines, and a single arrow press arrives as the three
 * characters `ESC [ A`. Everything an interface needs to know is in this file: which key it was,
 * and the character if it was a printable one.
 *
 * Reads are pull-based rather than event-based. A screen is a loop that asks for the next key and
 * decides what to draw, and an event emitter would mean every screen carrying its own "am I still
 * the one listening" flag, which is the bug that makes two menus respond to one keypress.
 */

const ESC = String.fromCharCode(27);

export type KeyName =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'enter'
  | 'escape'
  | 'tab'
  | 'shift-tab'
  | 'backspace'
  | 'delete'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-u'
  | 'ctrl-w'
  | 'space'
  | 'char'
  | 'unknown';

export interface Key {
  name: KeyName;
  /** Set for `char` and `space`. Empty for everything else. */
  value: string;
}

export interface KeyReader {
  next(): Promise<Key>;
  close(): void;
}

const SEQUENCES: Record<string, KeyName> = {
  '[A': 'up',
  '[B': 'down',
  '[C': 'right',
  '[D': 'left',
  OA: 'up',
  OB: 'down',
  OC: 'right',
  OD: 'left',
  '[H': 'home',
  '[F': 'end',
  '[1~': 'home',
  '[4~': 'end',
  '[3~': 'delete',
  '[5~': 'pageup',
  '[6~': 'pagedown',
  '[Z': 'shift-tab',
};

export function decode(chunk: string): Key {
  if (chunk === '\r' || chunk === '\n') return { name: 'enter', value: '' };
  if (chunk === '\t') return { name: 'tab', value: '' };
  if (chunk === ' ') return { name: 'space', value: ' ' };
  if (chunk === '\x7f' || chunk === '\b') return { name: 'backspace', value: '' };
  if (chunk === '\x03') return { name: 'ctrl-c', value: '' };
  if (chunk === '\x04') return { name: 'ctrl-d', value: '' };
  if (chunk === '\x15') return { name: 'ctrl-u', value: '' };
  if (chunk === '\x17') return { name: 'ctrl-w', value: '' };
  if (chunk === ESC) return { name: 'escape', value: '' };

  if (chunk.startsWith(ESC)) {
    const rest = chunk.slice(1);
    const name = SEQUENCES[rest];
    if (name) return { name, value: '' };
    // A mouse report or a paste-bracket wrapper. Swallowed rather than treated as text, so a stray
    // click cannot type into a field.
    return { name: 'unknown', value: '' };
  }

  // Printable, single character. Anything longer is a paste or a multi-byte sequence we did not
  // recognise; the first character is taken and the rest dropped, which keeps a field usable.
  const first = [...chunk][0] ?? '';
  if (first && first >= ' ') return { name: 'char', value: first };
  return { name: 'unknown', value: '' };
}

export function readKeys(input: NodeJS.ReadStream = process.stdin): KeyReader {
  const queue: Key[] = [];
  const waiting: Array<(key: Key) => void> = [];
  let closed = false;

  const push = (key: Key) => {
    const next = waiting.shift();
    if (next) next(key);
    else queue.push(key);
  };

  const onData = (data: Buffer | string) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    // One chunk can hold several keys when input arrives faster than the loop drains it, or when
    // somebody pastes. Splitting on ESC keeps each escape sequence whole.
    for (const part of splitChunks(text)) push(decode(part));
  };

  input.setEncoding('utf8');
  input.on('data', onData);
  input.resume();

  return {
    next(): Promise<Key> {
      const ready = queue.shift();
      if (ready) return Promise.resolve(ready);
      if (closed) return Promise.resolve({ name: 'ctrl-d', value: '' });
      return new Promise((resolve) => waiting.push(resolve));
    },
    close(): void {
      if (closed) return;
      closed = true;
      input.off('data', onData);
      input.pause();
      // Anything still awaiting a key is told the input ended, so no caller is left hanging.
      while (waiting.length > 0) waiting.shift()?.({ name: 'ctrl-d', value: '' });
    },
  };
}

/** Split a chunk into one entry per keypress, keeping `ESC [ A` together as one. */
export function splitChunks(text: string): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < text.length) {
    const ch = text[index]!;
    if (ch !== ESC) {
      out.push(ch);
      index += 1;
      continue;
    }
    let end = index + 1;
    if (text[end] === '[' || text[end] === 'O') {
      end += 1;
      while (end < text.length && !/[A-Za-z~]/.test(text[end]!)) end += 1;
      if (end < text.length) end += 1;
    }
    out.push(text.slice(index, end));
    index = end;
  }
  return out;
}
