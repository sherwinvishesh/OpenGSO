import { describe, expect, it } from 'vitest';
import { frameSplitter, parseFrame } from '../web-next/frames.js';

/** @import { Frame } from '../web-next/frames.js' */

/** @param {string[]} chunks */
function framesOf(chunks) {
  /** @type {Frame[]} */
  const out = [];
  const splitter = frameSplitter((frame) => out.push(frame));
  for (const chunk of chunks) splitter.push(chunk);
  splitter.end();
  return out;
}

describe('parseFrame', () => {
  it('reads the event and the JSON data', () => {
    expect(parseFrame('event: progress\ndata: {"phase":"fetch"}')).toEqual({ event: 'progress', data: { phase: 'fetch' } });
  });

  it('joins data split over several lines', () => {
    expect(parseFrame('event: done\ndata: {"status":\ndata: 200}')).toEqual({ event: 'done', data: { status: 200 } });
  });

  it('drops the keepalive comment, a frame with no event, and data that is not JSON', () => {
    expect(parseFrame(': keepalive')).toBeUndefined();
    expect(parseFrame('data: {}')).toBeUndefined();
    expect(parseFrame('event: done\ndata: {not json')).toBeUndefined();
  });
});

describe('frameSplitter', () => {
  const wire = 'event: progress\ndata: {"n":1}\n\n: keepalive\n\nevent: done\ndata: {"status":200,"body":{"ok":true}}\n\n';

  it('yields every frame from one chunk', () => {
    expect(framesOf([wire]).map((frame) => frame.event)).toEqual(['progress', 'done']);
  });

  it('yields the same frames however the stream is cut', () => {
    const whole = framesOf([wire]);
    for (let cut = 1; cut < wire.length; cut += 1) {
      expect(framesOf([wire.slice(0, cut), wire.slice(cut)])).toEqual(whole);
    }
  });

  it('accepts CRLF, including a CR and LF that arrive in different chunks', () => {
    const crlf = wire.replace(/\n/g, '\r\n');
    const whole = framesOf([wire]);
    expect(framesOf([crlf])).toEqual(whole);
    const cut = crlf.indexOf('\r\n') + 1;
    expect(framesOf([crlf.slice(0, cut), crlf.slice(cut)])).toEqual(whole);
  });

  it('delivers a final frame with no trailing blank line once the stream ends', () => {
    expect(framesOf(['event: done\ndata: {"status":200}'])).toEqual([{ event: 'done', data: { status: 200 } }]);
  });
});
