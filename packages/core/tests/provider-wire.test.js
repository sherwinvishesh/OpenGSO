import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callProvider, createAiEnhancer, DEFAULT_MAX_TOKENS } from '@omnigeo/core/generate';
/** @import { IncomingMessage, Server, ServerResponse } from 'node:http' */
/** @import { ProviderCall } from '@omnigeo/core/generate' */

/**
 * The one request in OmniGEO that carries the user's key, over a real socket.
 *
 * A loopback server stands in for each provider by being named as `baseUrl`, which the catalogue
 * honours for every row. It records what arrived and answers with whatever the test hands it, so
 * the request shape is checked byte for byte and every way an answer can go wrong is reachable
 * without a real provider or the network.
 */

const KEY = 'sk-wire-test-0123456789abcdef';

/**
 * @typedef {{ method: string; url: string; headers: IncomingMessage['headers']; body: any }} Received
 * @typedef {(request: IncomingMessage, response: ServerResponse) => void} Answer
 */

/** @type {Server} */
let server;
/** @type {string} */
let base;
/** @type {Received[]} */
let received;
/** @type {Answer} */
let answer;

beforeEach(async () => {
  received = [];
  answer = (_request, response) => json(response, 200, {});
  server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      received.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: raw ? JSON.parse(raw) : undefined });
      answer(request, response);
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen(undefined)));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(() => resolveClose(undefined)));
});

/**
 * @param {ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 */
function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * @param {Partial<ProviderCall>} overrides
 * @returns {ProviderCall}
 */
function call(overrides) {
  return {
    provider: 'anthropic',
    model: 'test-model',
    apiKey: KEY,
    system: 'the system prompt',
    prompt: 'the user prompt',
    ...overrides,
    overrides: { baseUrl: `${base}/v1`, ...overrides.overrides },
  };
}

/**
 * The thrown error, for a call that must fail.
 *
 * @param {ProviderCall} providerCall
 * @returns {Promise<Error>}
 */
async function failure(providerCall) {
  try {
    await callProvider(providerCall);
  } catch (error) {
    return /** @type {Error} */ (error);
  }
  throw new Error('The call was expected to fail and did not.');
}

/** What each wire shape looks like on a good day, and how each one reads back. */
const SHAPES = /** @type {const} */ ({
  anthropic: { provider: 'anthropic', good: { content: [{ type: 'text', text: '# Hello' }], stop_reason: 'end_turn' } },
  openai: { provider: 'openai', good: { choices: [{ message: { content: '# Hello' }, finish_reason: 'stop' }] } },
  gemini: { provider: 'gemini', good: { candidates: [{ content: { parts: [{ text: '# Hello' }] }, finishReason: 'STOP' }] } },
});

describe('the request each wire shape sends', () => {
  it('sends Anthropic a messages call with the key in x-api-key and the version pinned', async () => {
    answer = (_request, response) => json(response, 200, SHAPES.anthropic.good);
    await callProvider(call({ provider: 'anthropic', maxTokens: 321 }));

    const [request] = received;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/v1/messages');
    expect(request.headers['x-api-key']).toBe(KEY);
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.body).toEqual({
      model: 'test-model',
      max_tokens: 321,
      system: 'the system prompt',
      messages: [{ role: 'user', content: 'the user prompt' }],
    });
  });

  it('sends OpenAI a chat completion with a bearer key and the token field its newer models accept', async () => {
    answer = (_request, response) => json(response, 200, SHAPES.openai.good);
    await callProvider(call({ provider: 'openai' }));

    const [request] = received;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/v1/chat/completions');
    expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request.headers['x-api-key']).toBeUndefined();
    expect(request.body).toEqual({
      model: 'test-model',
      max_completion_tokens: DEFAULT_MAX_TOKENS,
      messages: [
        { role: 'system', content: 'the system prompt' },
        { role: 'user', content: 'the user prompt' },
      ],
    });
  });

  it('sends an OpenAI-compatible clone the max_tokens field the clones accept', async () => {
    answer = (_request, response) => json(response, 200, SHAPES.openai.good);
    await callProvider(call({ provider: 'groq', maxTokens: 50 }));

    const [request] = received;
    expect(request.url).toBe('/v1/chat/completions');
    expect(request.body.max_tokens).toBe(50);
    expect(request.body).not.toHaveProperty('max_completion_tokens');
  });

  it('sends Gemini a generateContent call with the key in a header and never in the URL', async () => {
    answer = (_request, response) => json(response, 200, SHAPES.gemini.good);
    await callProvider(call({ provider: 'gemini', model: 'models/odd name', maxTokens: 99 }));

    const [request] = received;
    expect(request.method).toBe('POST');
    // The model id is encoded, so one with a slash or a space cannot reshape the path.
    expect(request.url).toBe('/v1/models/models%2Fodd%20name:generateContent');
    expect(request.headers['x-goog-api-key']).toBe(KEY);
    expect(request.body).toEqual({
      systemInstruction: { parts: [{ text: 'the system prompt' }] },
      contents: [{ role: 'user', parts: [{ text: 'the user prompt' }] }],
      generationConfig: { maxOutputTokens: 99 },
    });
  });

  it('never puts the key in the URL, for any shape', async () => {
    for (const shape of Object.values(SHAPES)) {
      answer = (_request, response) => json(response, 200, shape.good);
      await callProvider(call({ provider: shape.provider }));
    }
    expect(received).toHaveLength(3);
    for (const request of received) expect(request.url).not.toContain(KEY);
  });

  it('sends no key at all to an endpoint configured for none, even when one is on hand', async () => {
    answer = (_request, response) => json(response, 200, SHAPES.openai.good);
    await callProvider(call({ provider: 'custom', overrides: { api: 'openai', auth: 'none' } }));

    const headers = JSON.stringify(received[0].headers);
    expect(headers).not.toContain(KEY);
    expect(received[0].headers.authorization).toBeUndefined();
  });

  it('adds configured gateway headers, drops a trailing slash on the base URL, and honours an auth override', async () => {
    answer = (_request, response) => json(response, 200, SHAPES.anthropic.good);
    await callProvider(
      call({
        provider: 'custom',
        overrides: { baseUrl: `${base}/gateway///`, api: 'anthropic', auth: 'bearer', headers: { 'x-team': 'docs' } },
      }),
    );

    const [request] = received;
    expect(request.url).toBe('/gateway/messages');
    expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request.headers['x-api-key']).toBeUndefined();
    expect(request.headers['x-team']).toBe('docs');
  });
});

describe('reading a good answer', () => {
  it('joins the text blocks of an Anthropic answer and skips what is not text', async () => {
    answer = (_request, response) =>
      json(response, 200, {
        content: [{ type: 'text', text: '# Title\n\n' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: 'Body.' }],
        stop_reason: 'end_turn',
      });
    expect(await callProvider(call({ provider: 'anthropic' }))).toBe('# Title\n\nBody.');
  });

  it('takes the first choice of an OpenAI answer', async () => {
    answer = (_request, response) =>
      json(response, 200, { choices: [{ message: { content: 'first' } }, { message: { content: 'second' } }] });
    expect(await callProvider(call({ provider: 'openai' }))).toBe('first');
  });

  it('joins the parts of the first Gemini candidate', async () => {
    answer = (_request, response) =>
      json(response, 200, { candidates: [{ content: { parts: [{ text: 'one ' }, { text: 'two' }] } }] });
    expect(await callProvider(call({ provider: 'gemini' }))).toBe('one two');
  });

  it('refuses an answer with no text in it rather than returning an empty document', async () => {
    const empty = { anthropic: { content: [] }, openai: { choices: [] }, gemini: { candidates: [] } };
    for (const [api, body] of Object.entries(empty)) {
      answer = (_request, response) => json(response, 200, body);
      const error = await failure(call({ provider: 'custom', overrides: { api: /** @type {any} */ (api) } }));
      expect(error.message, api).toMatch(/returned no/);
    }
  });
});

describe('an answer that goes wrong', () => {
  it('names the provider and the status on an HTTP error, and carries the status for the caller', async () => {
    answer = (_request, response) => json(response, 429, { error: { message: 'rate limited' } });
    const error = await failure(call({ provider: 'anthropic' }));
    expect(error.message).toContain('Anthropic Claude');
    expect(error.message).toContain('429');
    expect(error.message).toContain('rate limited');
    expect(/** @type {{ status?: number }} */ (error).status).toBe(429);
  });

  it("quotes the provider's own message out of each vendor's error envelope, not the envelope", async () => {
    for (const [body, expected] of /** @type {const} */ ([
      [{ type: 'error', error: { type: 'not_found_error', message: 'model: claude-sonet-9' }, request_id: 'req_0123' }, 'model: claude-sonet-9'],
      [[{ error: { code: 404, message: 'models/gemini-9 is not found', status: 'NOT_FOUND' } }], 'models/gemini-9 is not found'],
      [{ message: 'invalid model' }, 'invalid model'],
      [{ error: "model 'qwen9' not found" }, "model 'qwen9' not found"],
      [{ detail: 'Model not supported' }, 'Model not supported'],
    ])) {
      answer = (_request, response) => json(response, 404, body);
      const error = await failure(call({ provider: 'anthropic' }));
      expect(error.message).toContain(expected);
      expect(error.message).not.toContain('request_id');
    }
    answer = (_request, response) => json(response, 404, { weird: 'shape' });
    expect((await failure(call({ provider: 'anthropic' }))).message).toContain('{"weird":"shape"}');
  });

  it('names the model it asked for when the provider says there is no such thing', async () => {
    for (const status of [400, 404]) {
      answer = (_request, response) => json(response, status, { error: { message: 'no' } });
      const error = await failure(call({ provider: 'openai', model: 'gpt-typo' }));
      expect(error.message).toContain('this run asked for "gpt-typo"');
    }
    answer = (_request, response) => json(response, 401, { error: { message: 'no' } });
    expect((await failure(call({ provider: 'openai', model: 'gpt-typo' }))).message).not.toContain('gpt-typo');
  });

  it('caps how much of an error body it repeats', async () => {
    answer = (_request, response) => {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('x'.repeat(10_000));
    };
    const error = await failure(call({ provider: 'openai' }));
    expect(error.message.length).toBeLessThan(600);
  });

  it('rejects a body that is not JSON instead of returning it', async () => {
    answer = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<html>a captive portal</html>');
    };
    await expect(callProvider(call({ provider: 'openai' }))).rejects.toThrow();
  });

  // A body that is not an object at all is refused as "not JSON", a misplaced field as "no content".
  // Either is a named refusal the caller falls back from; a TypeError is what neither may be.
  it('rejects JSON of the wrong shape with a named refusal, not as a TypeError', async () => {
    const odd = [
      null,
      [],
      'a string',
      42,
      { content: 'not an array', choices: {}, candidates: 'x' },
      { content: [null], choices: [null], candidates: [null] },
      { choices: [{ message: { content: [{ type: 'image_url', image_url: 'x' }] } }], candidates: [{ content: { parts: 'x' } }] },
    ];
    for (const shape of Object.values(SHAPES)) {
      for (const body of odd) {
        answer = (_request, response) => json(response, 200, body);
        await expect(callProvider(call({ provider: shape.provider })), `${shape.provider} ${JSON.stringify(body)}`).rejects.toThrow(
          /returned no|not with JSON/,
        );
      }
    }
  });

  it('reads an answer sent as a list of parts, and only its text parts', async () => {
    answer = (_request, response) =>
      json(response, 200, {
        choices: [{ message: { content: [{ type: 'thinking', thinking: 'Let me see.' }, { type: 'text', text: '# Hi' }, { type: 'text', text: '\n\nBody.' }] } }],
      });
    expect(await callProvider(call({ provider: 'mistral' }))).toBe('# Hi\n\nBody.');
  });

  /** It used to come back as an array, which broke the enhancer outside its own try. */
  it('keeps the algorithmic page when a compatible server answers with parts that hold no text', async () => {
    answer = (_request, response) =>
      json(response, 200, { choices: [{ message: { content: [{ type: 'image_url', image_url: { url: 'x' } }] } }] });
    const enhance = createAiEnhancer({
      provider: 'custom',
      model: 'm',
      apiKey: '',
      env: {},
      overrides: { baseUrl: `${base}/v1`, api: 'openai', auth: 'none' },
    });
    const result = await enhance({ url: 'http://site.test/', title: 'Hi', html: '', algorithmicMarkdown: '# Hi\n\nBody.' });
    expect(result.fellBack).toBe(true);
    expect(result.markdown).toBe('# Hi\n\nBody.');
  });

  it('gives up on an endpoint that never answers, and says how long it waited', async () => {
    answer = () => {};
    const error = await failure(call({ provider: 'anthropic', timeoutMs: 50 }));
    expect(error.message).toMatch(/did not respond within/);
    // A limit the user set is the likely culprit, so the fix it names is the flag.
    expect(error.message).toContain('raise --timeout');
    expect(received).toHaveLength(1);
  });

  it('gives up on an endpoint that sends headers and then stalls on the body', async () => {
    answer = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"content":');
    };
    const error = await failure(call({ provider: 'anthropic', timeoutMs: 50 }));
    expect(error.message).toMatch(/did not respond within/);
  });

  it('fails cleanly when nothing is listening at all', async () => {
    const closed = base;
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(() => resolveClose(undefined)));
    const error = await failure({ ...call({ provider: 'openai' }), overrides: { baseUrl: closed } });
    expect(error).toBeInstanceOf(Error);
    // Reopened so `afterEach` has something to close.
    server = createServer();
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen(undefined)));
  });
});

/**
 * An error message is printed in the terminal, kept as a generate warning, and handed to the
 * dashboard in an API response, so the key must not be anywhere in one. A gateway that echoes the
 * request back in its error body is the case that would put it there.
 */
describe('the key in an error message', () => {
  it('is absent from every failure that does not echo it', async () => {
    /** @type {Answer[]} */
    const answers = [
      (_request, response) => json(response, 401, { error: 'invalid key' }),
      (_request, response) => json(response, 200, { choices: [] }),
      (_request, response) => {
        response.writeHead(302, { Location: 'http://elsewhere.invalid/' });
        response.end();
      },
      () => {},
    ];
    for (const next of answers) {
      answer = next;
      for (const shape of Object.values(SHAPES)) {
        const error = await failure(call({ provider: shape.provider, timeoutMs: 50 }));
        expect(error.message, shape.provider).not.toContain(KEY);
        expect(String(error.stack), shape.provider).not.toContain(KEY);
      }
    }
  });

  it('is absent even when the endpoint echoes the key back in an error body', async () => {
    for (const shape of Object.values(SHAPES)) {
      answer = (request, response) =>
        json(response, 401, { error: `Invalid key: ${JSON.stringify(request.headers)}` });
      const error = await failure(call({ provider: shape.provider }));
      expect(error.message, shape.provider).toContain('401');
      expect(error.message, shape.provider).toContain('Invalid key');
      expect(error.message, shape.provider).not.toContain(KEY);
    }
  });

  it('is absent even when the endpoint echoes the key back in a body that is not JSON', async () => {
    answer = (request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(`echo ${request.headers.authorization}`);
    };
    const error = await failure(call({ provider: 'openai' }));
    expect(error.message).not.toContain(KEY);
  });
});

describe('what the body carries beyond the page', () => {
  /**
   * The request an OpenAI-shaped provider sent.
   *
   * @param {Partial<ProviderCall>} overrides
   */
  const sent = async (overrides) => {
    answer = (_request, response) => json(response, 200, SHAPES.openai.good);
    await callProvider(call(overrides));
    return received[received.length - 1];
  };

  it('posts to Perplexity at its own path, with search switched off for its default model', async () => {
    const request = await sent({ provider: 'perplexity', model: 'sonar' });
    expect(request.url).toBe('/v1/sonar');
    expect(request.body.disable_search).toBe(true);
    expect(request.body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it('sends the catalogue flags with the default model and never with another one', async () => {
    expect((await sent({ provider: 'deepseek', model: 'deepseek-flash' })).body.thinking).toEqual({ type: 'disabled' });
    expect((await sent({ provider: 'deepseek', model: 'deepseek-pro' })).body).not.toHaveProperty('thinking');
    expect((await sent({ provider: 'qwen', model: 'qwen-plus' })).body.enable_thinking).toBe(false);
    expect((await sent({ provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b' })).body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('keeps Sonnet 5.5 at its lowest thinking setting, which it accepts in place of disabled', async () => {
    answer = (_request, response) => json(response, 200, SHAPES.anthropic.good);
    await callProvider(call({ provider: 'anthropic', model: 'claude-sonnet-5-5' }));
    expect(received[0].body.thinking).toEqual({ type: 'between_tools' });
    await callProvider(call({ provider: 'anthropic', model: 'claude-opus-5-5' }));
    expect(received[1].body).not.toHaveProperty('thinking');
  });

  it('merges ai.params over the catalogue, object into object, and a null takes a field out', async () => {
    const request = await sent({
      provider: 'deepseek',
      model: 'deepseek-flash',
      overrides: { params: { thinking: null, temperature: 0.2, response_format: { type: 'text' } } },
    });
    expect(request.body).not.toHaveProperty('thinking');
    expect(request.body.temperature).toBe(0.2);
    expect(request.body.response_format).toEqual({ type: 'text' });

    answer = (_request, response) => json(response, 200, SHAPES.gemini.good);
    await callProvider(call({ provider: 'gemini', overrides: { params: { generationConfig: { temperature: 0 } } } }));
    expect(received[received.length - 1].body.generationConfig).toEqual({ maxOutputTokens: DEFAULT_MAX_TOKENS, temperature: 0 });
  });

  it('never lets ai.params replace the model, the page or the stream setting', async () => {
    const params = JSON.parse('{"model":"other","messages":[],"system":"x","stream":true,"__proto__":{"polluted":true},"top_p":0.9}');
    const request = await sent({ provider: 'openai', overrides: { params } });
    expect(request.body.model).toBe('test-model');
    expect(request.body.messages).toHaveLength(2);
    expect(request.body).not.toHaveProperty('stream');
    expect(request.body).not.toHaveProperty('system');
    expect(request.body.top_p).toBe(0.9);
    expect(/** @type {any} */ ({}).polluted).toBeUndefined();
  });

  it('drops a row\'s own path and flags once its API shape is overridden', async () => {
    answer = (_request, response) => json(response, 200, SHAPES.anthropic.good);
    await callProvider(call({ provider: 'perplexity', model: 'sonar', overrides: { api: 'anthropic' } }));
    expect(received[0].url).toBe('/v1/messages');
    expect(received[0].body).not.toHaveProperty('disable_search');
  });
});

describe('answers that are not the page', () => {
  it('strips reasoning a model left at the top of its answer, and only there', async () => {
    answer = (_request, response) =>
      json(response, 200, { choices: [{ message: { content: '<think>\nThe user wants a table.\n</think>\n\n# Page\n\nUse `<think>` tags.' } }] });
    expect(await callProvider(call({ provider: 'groq' }))).toBe('# Page\n\nUse `<think>` tags.');
  });

  it('skips Anthropic thinking blocks and Gemini thought parts', async () => {
    answer = (_request, response) =>
      json(response, 200, { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '# A' }], stop_reason: 'end_turn' });
    expect(await callProvider(call({ provider: 'anthropic' }))).toBe('# A');
    answer = (_request, response) =>
      json(response, 200, { candidates: [{ content: { parts: [{ text: 'hmm', thought: true }, { text: '# B' }] }, finishReason: 'STOP' }] });
    expect(await callProvider(call({ provider: 'gemini' }))).toBe('# B');
  });

  it('says a model declined, in each shape, rather than reporting an empty answer', async () => {
    /** @type {Array<[string, unknown]>} */
    const refusals = [
      ['anthropic', { content: [], stop_reason: 'refusal' }],
      ['openai', { choices: [{ message: { content: null, refusal: 'I can not help with that.' }, finish_reason: 'stop' }] }],
      ['gemini', { promptFeedback: { blockReason: 'SAFETY' } }],
      ['gemini', { candidates: [{ finishReason: 'SAFETY' }] }],
    ];
    for (const [provider, body] of refusals) {
      answer = (_request, response) => json(response, 200, body);
      const error = await failure(call({ provider: /** @type {any} */ (provider) }));
      expect(error.message, provider).toMatch(/declined to rewrite this page/);
    }
  });

  it('says where to look after the status line, without changing the status line', async () => {
    for (const [status, hint] of /** @type {const} */ ([
      [401, /key was refused/],
      [402, /out of credit/],
      [404, /model id/],
      [429, /Rate limited/],
      [503, /on its side/],
    ])) {
      answer = (_request, response) => json(response, status, { error: 'no' });
      const error = await failure(call({ provider: 'openai' }));
      expect(error.message.split('\n')[0]).toBe(`The OpenAI API returned ${status}.`);
      expect(error.message).toMatch(hint);
    }
  });
});
