import type {
  AiBot,
  ApiProgress,
  GenerateResponse,
  History,
  OpenGeoConfig,
  ProdResponse,
  SitePreview,
  State,
  TestMode,
  TestResponse,
} from './types';

/**
 * Every call goes to this page's own origin, which is 127.0.0.1. There is no other host in this
 * file and there never should be: the dashboard's whole claim is that nothing leaves the machine.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(`The server replied with something that was not JSON (${response.status}).`, response.status);
  }
  if (!response.ok) {
    const record = (body ?? {}) as Record<string, unknown>;
    throw new ApiError(String(record.error ?? `Request failed (${response.status}).`), response.status, record);
  }
  return body as T;
}

/**
 * A POST whose reply arrives as a stream of server-sent events instead of one JSON object.
 *
 * `EventSource` is not used, even though the wire format is `text/event-stream`. EventSource can
 * only issue a GET, and both of these endpoints do something: one writes a run to the history file,
 * the other writes markdown to disk. A GET that does either is reachable from any page on the
 * internet through an `<img src>`, which sends no `Origin` header and so slips past the same-origin
 * guard that protects every other route. A POST carrying a JSON content type cannot be forged that
 * way, so the frames are parsed here by hand. Twenty lines, and the endpoint stays as safe as the
 * rest of the API.
 *
 * The result is the last frame rather than the response body, so the caller still awaits one value
 * and still throws one `ApiError`. Progress is a side channel, and a caller that does not care
 * passes nothing.
 */
async function stream<T>(path: string, input: unknown, onProgress?: (event: ApiProgress) => void): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  // A refusal from the handler arrives inside the final frame, with its own status, because by then
  // the 200 has long since gone out. This is the transport failing before any of that.
  if (!response.ok) throw new ApiError(`Request failed (${response.status}).`, response.status);

  let last: { status: number; body: unknown } | undefined;
  await readFrames(response, (event, data) => {
    if (event === 'progress') onProgress?.(data as ApiProgress);
    if (event === 'done') last = data as { status: number; body: unknown };
  });

  if (!last) {
    throw new ApiError('The run ended without sending a result. The server was probably stopped.', 0);
  }
  const record = (last.body ?? {}) as Record<string, unknown>;
  if (last.status !== 200) {
    throw new ApiError(String(record.error ?? `Request failed (${last.status}).`), last.status, record);
  }
  return last.body as T;
}

/**
 * Frames off a streaming response.
 *
 * A blank line ends a frame, so the buffer is split on that and the trailing piece is carried into
 * the next chunk: a frame arrives in two pieces often enough that not doing this loses the biggest
 * one every time. A body that cannot be streamed at all is read whole instead, which costs the
 * narration and nothing else.
 */
async function readFrames(response: Response, onFrame: (event: string, data: unknown) => void): Promise<void> {
  let buffer = '';
  const flush = (final: boolean) => {
    const blocks = buffer.split('\n\n');
    buffer = final ? '' : (blocks.pop() ?? '');
    for (const block of blocks) {
      const frame = parseFrame(block);
      if (frame) onFrame(frame.event, frame.data);
    }
  };

  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      flush(false);
    }
    buffer += decoder.decode();
  } else {
    buffer = await response.text();
  }
  flush(true);
}

/** A line beginning with a colon is a comment, which is what the server's keepalive sends. */
function parseFrame(block: string): { event: string; data: unknown } | undefined {
  let event = '';
  const data: string[] = [];
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

export const api = {
  state: () => call<State>('/api/state'),
  bots: () => call<{ bots: AiBot[] }>('/api/bots'),
  history: () => call<History>('/api/history'),
  saveConfig: (patch: Partial<OpenGeoConfig>) =>
    call<{ config: OpenGeoConfig; configPath: string }>('/api/config', { method: 'POST', body: JSON.stringify(patch) }),
  preview: (url: string) => call<{ preview: SitePreview }>('/api/preview', { method: 'POST', body: JSON.stringify({ url }) }),
  // The two long ones go to the streaming variants unconditionally. There is one code path rather
  // than a fast one and a narrated one, because a run that reports nothing for four minutes is
  // indistinguishable from a hang and nobody should have to opt in to knowing. `/api/test` and
  // `/api/generate` still answer with plain JSON for anything that is not a browser.
  test: (input: { url?: string; mode?: TestMode; maxDocs?: number }, onProgress?: (event: ApiProgress) => void) =>
    stream<TestResponse>('/api/test/stream', input, onProgress),
  generate: (
    input: { url?: string; tier?: 'free' | 'ai'; single?: boolean; force?: boolean; skipSiteFiles?: boolean },
    onProgress?: (event: ApiProgress) => void,
  ) => stream<GenerateResponse>('/api/generate/stream', input, onProgress),
  prodTest: (input: { url?: string; bot?: string }) =>
    call<ProdResponse>('/api/prod-test', { method: 'POST', body: JSON.stringify(input) }),
  readFile: (path: string) =>
    call<{ path: string; content: string }>('/api/file', { method: 'POST', body: JSON.stringify({ path }) }),
  saveKey: (input: {
    provider: string;
    apiKey: string;
    model?: string;
    baseUrl?: string;
    api?: string;
    auth?: string;
  }) =>
    call<{ provider: string; model: string; envPath: string; gitignorePath: string; gitignoreAdded: boolean }>('/api/key', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
