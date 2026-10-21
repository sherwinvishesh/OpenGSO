import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { callProvider, crawlSite } from '@opengso/core/generate';
import { MAX_PROBE_BYTES, probe } from '@opengso/core/shared';
import { gatherEvidence, testEvidence } from '@opengso/core/test';
/** @import { IncomingMessage, ServerResponse } from 'node:http' */

/**
 * What a remote server is allowed to make OpenGSO do.
 *
 * The tested site and the provider endpoint are both somebody else's machine. Neither gets to make
 * the process hold an unbounded body in memory, and the provider does not get to forward the key
 * somewhere else with a redirect.
 */

/**
 * @param {(req: IncomingMessage, res: ServerResponse) => void} handler
 * @returns {Promise<{ base: string; close: () => Promise<void> }>}
 */
async function serve(handler) {
  const server = createServer(handler);
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      /** @type {Promise<void>} */ (
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
      ),
  };
}

/**
 * A body that is as long as the client keeps reading, in 64 KiB chunks.
 * @param {string} type
 */
function endless(type) {
  /**
   * @param {IncomingMessage} _req
   * @param {ServerResponse} res
   */
  return (_req, res) => {
    res.writeHead(200, { 'content-type': type });
    const chunk = Buffer.alloc(64 * 1024, 'a');
    let sent = 0;
    const pump = () => {
      while (sent < 64 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) return void res.once('drain', pump);
      }
      res.end();
    };
    res.on('close', () => (sent = Number.POSITIVE_INFINITY));
    pump();
  };
}

describe('probe reads a bounded body', () => {
  it('stops at the byte cap and says it did', async () => {
    const server = await serve(endless('text/html'));
    try {
      const result = await probe(server.base, { maxBytes: 100_000 });
      expect(result.ok).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.body.length).toBeLessThanOrEqual(100_000);
    } finally {
      await server.close();
    }
  });

  it('has a default cap', () => {
    expect(MAX_PROBE_BYTES).toBeGreaterThan(1024 * 1024);
    expect(MAX_PROBE_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it('reads nothing when the caller turns the body down from the headers', async () => {
    const server = await serve(endless('application/pdf'));
    try {
      const result = await probe(server.base, { readBody: (headers) => (headers.get('content-type') ?? '').includes('html') });
      expect(result.status).toBe(200);
      expect(result.body).toBe('');
      expect(result.truncated).toBeFalsy();
    } finally {
      await server.close();
    }
  });

  it('leaves a small body whole', async () => {
    const server = await serve((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('héllo'));
    try {
      const result = await probe(server.base);
      expect(result.body).toBe('héllo');
      expect(result.truncated).toBeFalsy();
    } finally {
      await server.close();
    }
  });
});

describe('probe and a dropped connection', () => {
  it('tries a GET once more when the server drops the connection before answering', async () => {
    let requests = 0;
    const site = await serve((req, res) => {
      requests += 1;
      if (requests === 1) return void req.socket.destroy();
      res.end('second time');
    });
    try {
      const result = await probe(`${site.base}/`);
      expect(result.error).toBeUndefined();
      expect(result.body).toBe('second time');
      expect(requests).toBe(2);
    } finally {
      await site.close();
    }
  });

  it('does not send a POST twice', async () => {
    let requests = 0;
    const site = await serve((req) => {
      requests += 1;
      req.socket.destroy();
    });
    try {
      const result = await probe(`${site.base}/`, { method: 'POST' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/fetch failed/);
      expect(requests).toBe(1);
    } finally {
      await site.close();
    }
  });

  it('records why a fetch failed, not only that it did', async () => {
    const site = await serve((req, res) => {
      if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
      } else {
        req.socket.destroy();
      }
    });
    try {
      // Undici says "fetch failed" for both; the cause is the only thing that tells them apart.
      expect((await probe(`${site.base}/loop`)).error).toBe('fetch failed: redirect count exceeded');
      expect((await probe(`${site.base}/`, { method: 'POST' })).error).toMatch(/^fetch failed: (UND_ERR_SOCKET|ECONNRESET)/);
    } finally {
      await site.close();
    }
  });

  it('gives up after the one retry', async () => {
    let requests = 0;
    const site = await serve((req) => {
      requests += 1;
      req.socket.destroy();
    });
    try {
      const result = await probe(`${site.base}/`);
      expect(result.ok).toBe(false);
      expect(requests).toBe(2);
    } finally {
      await site.close();
    }
  });
});

describe('the crawler', () => {
  it('skips a page over the cap rather than parsing half of it', async () => {
    const server = await serve(endless('text/html'));
    try {
      const result = await crawlSite({ site: server.base });
      expect(result.pages).toHaveLength(0);
      expect(result.failures[0]?.reason).toMatch(/larger than/i);
    } finally {
      await server.close();
    }
  });

  it('skips a non-HTML response without downloading it', async () => {
    const server = await serve(endless('application/pdf'));
    try {
      const result = await crawlSite({ site: server.base });
      expect(result.pages).toHaveLength(0);
      expect(result.failures[0]?.reason).toContain('application/pdf');
    } finally {
      await server.close();
    }
  });
});

describe('a provider call', () => {
  it('does not follow a redirect, so the key never reaches the second host', async () => {
    /** @type {Array<string | undefined>} */
    const reached = [];
    const elsewhere = await serve((req, res) => {
      reached.push(/** @type {string | undefined} */ (req.headers['x-api-key']));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }));
    });
    const gateway = await serve((_req, res) => res.writeHead(307, { location: `${elsewhere.base}/v1/messages` }).end());
    try {
      await expect(
        callProvider({
          provider: 'custom',
          model: 'm',
          apiKey: 'sk-test-not-a-real-key',
          system: 's',
          prompt: 'p',
          overrides: { baseUrl: `${gateway.base}/v1`, api: 'anthropic', auth: 'x-api-key' },
        }),
      ).rejects.toThrow(/redirect/i);
      expect(reached).toEqual([]);
    } finally {
      await gateway.close();
      await elsewhere.close();
    }
  });
});

describe('the twin a page advertises', () => {
  /**
   * A page whose Link header points its markdown twin wherever the test says.
   * @param {string} link
   */
  function advertising(link) {
    /**
     * @param {IncomingMessage} _req
     * @param {ServerResponse} res
     */
    return (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', link: `<${link}>; rel="alternate"; type="text/markdown"` });
      res.end('<html><body><main><h1>Hi</h1><p>Words.</p></main></body></html>');
    };
  }

  it('is not fetched from another origin', async () => {
    /** @type {string[]} */
    const hits = [];
    const elsewhere = await serve((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/markdown' }).end('# Not yours');
    });
    const site = await serve(advertising(`${elsewhere.base}/twin.md`));
    try {
      const evidence = await gatherEvidence(new URL(`${site.base}/page`), { timeoutMs: 5000 });
      expect(hits).toEqual([]);
      expect(evidence.advertisedTwinUrl).toBeUndefined();
      expect(evidence.twinUrl).toBe(`${site.base}/page.md`);
      const b8 = testEvidence(evidence).checks.find((check) => check.id === 'B8');
      // There is no twin on this site, so B8 is locked behind B1; what it saw is kept as the detail.
      expect(b8?.status).toBe('locked');
      expect(b8?.detail).toContain(`${elsewhere.base}/twin.md`);
      expect(b8?.detail).toMatch(/not on this site/i);
    } finally {
      await site.close();
      await elsewhere.close();
    }
  });

  it('is not fetched when it is not http or https', async () => {
    const site = await serve(advertising('data:text/markdown,%23%20Forged'));
    try {
      const evidence = await gatherEvidence(new URL(`${site.base}/page`), { timeoutMs: 5000 });
      expect(evidence.advertisedTwinUrl).toBeUndefined();
      expect(evidence.twin.body).not.toContain('Forged');
    } finally {
      await site.close();
    }
  });

  it('is used when it is on the same origin', async () => {
    const site = await serve((req, res) => {
      if (req.url === '/docs/page.md') return void res.writeHead(200, { 'content-type': 'text/markdown' }).end('# Page');
      advertising('/docs/page.md')(req, res);
    });
    try {
      const evidence = await gatherEvidence(new URL(`${site.base}/page`), { timeoutMs: 5000 });
      expect(evidence.advertisedTwinUrl).toBe(`${site.base}/docs/page.md`);
      expect(evidence.twin.body).toBe('# Page');
    } finally {
      await site.close();
    }
  });
});

describe('the body, in the encoding the page declared', () => {
  // "café" in Latin-1 is one byte per letter; read as UTF-8 the é becomes U+FFFD.
  const latin1 = Buffer.from([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]);

  it('reads the charset from the Content-Type header', async () => {
    const site = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
      res.end(latin1);
    });
    try {
      expect((await probe(`${site.base}/`)).body).toBe('<p>café</p>');
    } finally {
      await site.close();
    }
  });

  it('falls back to a <meta charset> in the markup when the header names none', async () => {
    const site = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(Buffer.concat([Buffer.from('<html><head><meta charset="windows-1252"></head>'), latin1]));
    });
    try {
      expect((await probe(`${site.base}/`)).body).toContain('<p>café</p>');
    } finally {
      await site.close();
    }
  });

  it('decodes as UTF-8 when nothing is declared, and when the label is one Node does not know', async () => {
    const utf8 = Buffer.from('<p>café</p>', 'utf8');
    const site = await serve((req, res) => {
      res.writeHead(200, { 'content-type': req.url === '/bogus' ? 'text/html; charset=klingon-7' : 'text/html' });
      res.end(utf8);
    });
    try {
      expect((await probe(`${site.base}/`)).body).toBe('<p>café</p>');
      expect((await probe(`${site.base}/bogus`)).body).toBe('<p>café</p>');
    } finally {
      await site.close();
    }
  });
});
