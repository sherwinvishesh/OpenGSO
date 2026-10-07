import { frameSplitter } from './frames.js';

/**
 * @import {
 *   ApiProgress, BotsResponse, ConfigResponse, FileResponse, GenerateResponse, History, KeyResponse,
 *   OpenGeoConfig, PreviewResponse, ProdVerification, StateResponse, StreamDone, TestMode, TestResponse,
 * } from '../../core/src/shared/api-types.js'
 */

/**
 * Every call goes to this page's own origin, which is 127.0.0.1. There is no other host in this
 * file and there never should be: the dashboard's whole claim is that nothing leaves the machine.
 *
 * The types come from core, the module the server builds these replies with, so a field renamed
 * there fails the type check here instead of rendering `undefined`.
 */

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {Record<string, unknown>} [extra]
   */
  constructor(message, status, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/**
 * @template T
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<T>}
 */
async function call(path, init) {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  /** @type {unknown} */
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(`The server replied with something that was not JSON (${response.status}).`, response.status);
  }
  if (!response.ok) {
    const record = /** @type {Record<string, unknown>} */ (body ?? {});
    throw new ApiError(String(record.error ?? `Request failed (${response.status}).`), response.status, record);
  }
  return /** @type {T} */ (body);
}

/** @param {unknown} body */
const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });

/**
 * A POST whose reply arrives as a stream of server-sent events instead of one JSON object.
 *
 * `EventSource` is not used, even though the wire format is `text/event-stream`. EventSource can
 * only issue a GET, and both of these endpoints do something: one writes a run to the history file,
 * the other writes markdown to disk. A GET that does either is reachable from any page on the
 * internet through an `<img src>`, which sends no `Origin` header and so slips past the same-origin
 * guard that protects every other route. A POST carrying a JSON content type cannot be forged that
 * way, and the server answers 415 to any API POST without one, so the frames are parsed by hand.
 *
 * The result is the last frame rather than the response body, so the caller still awaits one value
 * and still throws one `ApiError`. Progress is a side channel. Aborting `signal` closes the
 * connection, which is how the server learns to stop.
 *
 * @template T
 * @param {string} path
 * @param {unknown} input
 * @param {((event: ApiProgress) => void) | undefined} onProgress
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<T>}
 */
async function stream(path, input, onProgress, signal) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  // A refusal from the handler arrives inside the final frame, with its own status, because by then
  // the 200 has long since gone out. This is the transport failing before any of that.
  if (!response.ok) throw new ApiError(`Request failed (${response.status}).`, response.status);

  /** @type {StreamDone | undefined} */
  let last;
  const splitter = frameSplitter(({ event, data }) => {
    if (event === 'progress') onProgress?.(/** @type {ApiProgress} */ (data));
    if (event === 'done') last = /** @type {StreamDone} */ (data);
  });

  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      splitter.push(decoder.decode(value, { stream: true }));
    }
    splitter.push(decoder.decode());
  } else {
    // A body that cannot be streamed is read whole, which costs the narration and nothing else.
    splitter.push(await response.text());
  }
  splitter.end();

  if (!last) {
    throw new ApiError('The run ended without sending a result. The server was probably stopped.', 0);
  }
  const record = /** @type {Record<string, unknown>} */ (last.body ?? {});
  if (last.status !== 200) {
    throw new ApiError(String(record.error ?? `Request failed (${last.status}).`), last.status, record);
  }
  return /** @type {T} */ (last.body);
}

/**
 * @typedef {{ url?: string; mode?: TestMode; maxDocs?: number }} TestInput
 * @typedef {{ url?: string; tier?: 'free' | 'ai'; single?: boolean; force?: boolean; skipSiteFiles?: boolean }} GenerateInput
 * @typedef {{ provider: string; apiKey: string; model?: string; baseUrl?: string; api?: string; auth?: string }} KeyInput
 */

export const api = {
  /** @returns {Promise<StateResponse>} */
  state: () => call('/api/state'),
  /** @returns {Promise<BotsResponse>} */
  bots: () => call('/api/bots'),
  /** @returns {Promise<History>} */
  history: () => call('/api/history'),
  /**
   * @param {Partial<OpenGeoConfig>} patch
   * @returns {Promise<ConfigResponse>}
   */
  saveConfig: (patch) => call('/api/config', post(patch)),
  /**
   * @param {string} url
   * @param {AbortSignal} [signal]
   * @returns {Promise<PreviewResponse>}
   */
  preview: (url, signal) => call('/api/preview', { ...post({ url }), signal }),
  // The two long ones go to the streaming variants unconditionally. There is one code path rather
  // than a fast one and a narrated one, because a run that reports nothing for four minutes is
  // indistinguishable from a hang and nobody should have to opt in to knowing. `/api/test` and
  // `/api/generate` still answer with plain JSON for anything that is not a browser.
  /**
   * @param {TestInput} input
   * @param {(event: ApiProgress) => void} [onProgress]
   * @param {AbortSignal} [signal]
   * @returns {Promise<TestResponse>}
   */
  test: (input, onProgress, signal) => stream('/api/test/stream', input, onProgress, signal),
  /**
   * @param {GenerateInput} input
   * @param {(event: ApiProgress) => void} [onProgress]
   * @param {AbortSignal} [signal]
   * @returns {Promise<GenerateResponse>}
   */
  generate: (input, onProgress, signal) => stream('/api/generate/stream', input, onProgress, signal),
  /**
   * @param {{ url?: string; bot?: string }} input
   * @returns {Promise<ProdVerification>}
   */
  prodTest: (input) => call('/api/prod-test', post(input)),
  /**
   * @param {string} path
   * @returns {Promise<FileResponse>}
   */
  readFile: (path) => call('/api/file', post({ path })),
  /**
   * @param {KeyInput} input
   * @returns {Promise<KeyResponse>}
   */
  saveKey: (input) => call('/api/key', post(input)),
};
