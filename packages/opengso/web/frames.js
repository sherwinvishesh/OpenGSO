/**
 * Server-sent event frames, parsed by hand.
 *
 * Nothing here touches the network or the page, so the tests feed it strings. `api.js` is the only
 * caller: it pushes decoded chunks in as they arrive and gets whole frames out.
 */

/**
 * @typedef {object} Frame
 * @property {string} event
 * @property {unknown} data
 */

/**
 * One block between blank lines. A line beginning with a colon is a comment, which is what the
 * server's keepalive sends, and a block with no event or no parseable data is dropped.
 *
 * @param {string} block
 * @returns {Frame | undefined}
 */
export function parseFrame(block) {
  let event = '';
  /** @type {string[]} */
  const data = [];
  for (const raw of block.split('\n')) {
    const line = raw.trimEnd();
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!event || data.length === 0) return undefined;
  try {
    return { event, data: JSON.parse(data.join('\n')) };
  } catch {
    return undefined;
  }
}

/**
 * Turns chunks into frames.
 *
 * A blank line ends a frame, so the buffer is split on that and the trailing piece is carried into
 * the next chunk: a frame arrives in two pieces often enough that not doing this loses the biggest
 * one every time.
 *
 * @param {(frame: Frame) => void} onFrame
 * @returns {{ push: (text: string) => void; end: () => void }}
 */
export function frameSplitter(onFrame) {
  let buffer = '';
  /** @param {boolean} final */
  const flush = (final) => {
    const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
    buffer = final ? '' : (blocks.pop() ?? '');
    for (const block of blocks) {
      const frame = parseFrame(block);
      if (frame) onFrame(frame);
    }
  };
  return {
    push(text) {
      buffer += text;
      flush(false);
    },
    end() {
      flush(true);
    },
  };
}
