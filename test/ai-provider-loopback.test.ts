import { test, describe, after, before } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatibleProvider, ProviderError, resolveProviderSettings } from '../src/ai/provider';

/**
 * The unit matrix in `test/ai-provider.test.ts` drives an injected transport, which is
 * what makes the request shape observable. That also means it never proves the *real*
 * `fetch` accepts what this module builds — a `RequestInit` the fake tolerates can still
 * fail against a live server. This file is the one place that talks to a socket, and it is
 * loopback only: `127.0.0.1` on an ephemeral port, in-process, no external host, no DNS.
 *
 * It lives in its own file because `npm test` runs one process per file, so a lingering
 * keep-alive socket cannot delay or hang any other suite.
 */
type Hit = { method?: string; url?: string; authorization?: string; body: string };

describe('provider over a real socket (#24)', () => {
  const hits: Hit[] = [];
  let server: http.Server;
  let base = '';

  before(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        hits.push({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        // The client appends `/chat/completions` to whatever base it is given, so these
        // routes are matched by prefix: `/redirect` arrives as `/redirect/chat/completions`.
        if (req.url?.startsWith('/redirect')) {
          // A 302 back at the client must not be followed with the bearer token attached.
          res.writeHead(302, { location: 'http://127.0.0.1:1/v1/chat/completions' });
          res.end();
          return;
        }
        if (req.url?.startsWith('/silent')) {
          // Measured, not assumed: a peer that takes the request and answers nothing — or
          // destroys its socket after reading it — produces no rejection in undici at all.
          // The request just sits there. The timeout is the only thing that ends it, which
          // is precisely why this module sets one on every request.
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    // undici keeps its sockets: closing the server alone leaves the file hanging until
    // the keep-alive timeout expires, which is exactly the CI flake this avoids.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('a real fetch round trip reaches the endpoint the module computed', async () => {
    const provider = new OpenAICompatibleProvider(
      resolveProviderSettings({ baseUrl: `${base}/v1`, apiKey: 'sk-loopback-42' }, {}),
      { timeoutMs: 5_000 }
    );
    const reply = await provider.complete({
      messages: [{ role: 'user', content: 'answer in json' }],
      expectJson: true,
    });

    assert.strictEqual(hits.length, 1);
    const [hit] = hits;
    assert.strictEqual(hit.method, 'POST');
    assert.strictEqual(hit.url, '/v1/chat/completions', 'the configured prefix is kept and the path added once');
    assert.strictEqual(hit.authorization, 'Bearer sk-loopback-42');
    const sent = JSON.parse(hit.body) as Record<string, unknown>;
    assert.ok(!('max_tokens' in sent), 'the opt-in token cap is not sent unless asked for');
    assert.deepStrictEqual(sent.response_format, { type: 'json_object' });
    assert.ok(Array.isArray(sent.messages));

    assert.deepStrictEqual(reply.json, { ok: true });
    assert.deepStrictEqual(reply.usage, { promptTokens: 9, completionTokens: 3, totalTokens: 12 });
  });

  test('a redirect is not followed, and the credential is not re-sent', async () => {
    const provider = new OpenAICompatibleProvider(
      resolveProviderSettings({ baseUrl: `${base}/redirect`, apiKey: 'sk-never-refollowed' }, {}),
      { timeoutMs: 5_000 }
    );
    const before = hits.length;
    await assert.rejects(
      () => provider.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError, `expected a classified failure, got ${String(err)}`);
        assert.strictEqual(err.kind, 'network', 'a refused redirect surfaces as a transport outcome');
        return true;
      }
    );
    assert.strictEqual(hits.length, before + 1, 'the client made one request; the redirect target was never contacted');
  });

  test('a peer that goes silent is bounded by the timeout instead of hanging the CLI', async () => {
    // This is the case a fake transport cannot show: against a socket the other end simply
    // stops answering, `fetch` does not reject, so the only thing standing between
    // `palee config test-connection` and an unkillable wait is this deadline. It is asserted
    // here against a live socket rather than reasoned about.
    const provider = new OpenAICompatibleProvider(
      resolveProviderSettings({ baseUrl: `${base}/silent`, apiKey: 'sk-never-echoed' }, {}),
      { timeoutMs: 250 }
    );
    await assert.rejects(
      () => provider.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError, `expected a classified failure, got ${String(err)}`);
        assert.strictEqual(err.kind, 'network');
        assert.match(err.message, /within 250 ms/);
        assert.ok(!err.message.includes('sk-never-echoed'), err.message);
        return true;
      }
    );
  });
});
