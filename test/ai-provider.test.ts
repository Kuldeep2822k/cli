import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  OpenAICompatibleProvider,
  ProviderError,
  resolveProviderSettings,
  normalizeProviderEndpoint,
  isLoopbackHost,
  DEFAULT_MODEL,
  API_KEY_ENV,
  MAX_MESSAGE_CHARS,
  MAX_RESPONSE_BYTES,
  describeForeignText,
  type ChatReply,
  type Transport,
} from '../src/ai/provider';

/**
 * #24 gives PALEE its first outbound call, so these tests never touch a real host: every
 * one of them drives an injected {@link Transport}. That seam is the reason the URL
 * building, the header assembly, the retry count and the redaction are observable at all —
 * a test that only checked "it threw" would pass on an implementation that sent the
 * credential in the wrong header, or to a host this module promises not to reach.
 */

interface RecordedCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

type Handler = (call: number, init: RequestInit) => Response | Promise<Response>;

function recorder(handler: Handler): { transport: Transport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport: Transport = async (url, init) => {
    calls.push({
      url,
      init,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: init.headers as Record<string, string>,
    });
    return handler(calls.length, init);
  };
  return { transport, calls };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function completion(content: unknown, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ choices: [{ message: { content }, ...extra }] });
}

const KEY = 'testkey-test-9f2c7a';

function settings(over: Partial<ReturnType<typeof resolveProviderSettings>> = {}) {
  const base = resolveProviderSettings({ baseUrl: 'https://gw.example/v1', apiKey: KEY }, {});
  return { ...base, ...over };
}

function providerFor(handler: Handler, options = {}): { p: OpenAICompatibleProvider; calls: RecordedCall[] } {
  const { transport, calls } = recorder(handler);
  return { p: new OpenAICompatibleProvider(settings(), { transport, ...options }), calls };
}

describe('provider endpoint validation (#24)', () => {
  test('https is accepted and kept exactly as configured', () => {
    const resolved = resolveProviderSettings({ baseUrl: 'https://opencode.ai/zen/v1', apiKey: KEY }, {});
    assert.strictEqual(resolved.baseUrl, 'https://opencode.ai/zen/v1');
    assert.strictEqual(resolved.keySource, 'config');
    assert.strictEqual(resolved.apiKey, KEY);
  });

  test('the environment key outranks the stored key, and which one won is reported', () => {
    const fromEnv = resolveProviderSettings({ baseUrl: 'https://h/v1', apiKey: KEY }, { [API_KEY_ENV]: 'testkey-from-env' });
    assert.strictEqual(fromEnv.apiKey, 'testkey-from-env');
    assert.strictEqual(fromEnv.keySource, 'env');

    const blank = resolveProviderSettings({ baseUrl: 'https://h/v1', apiKey: KEY }, { [API_KEY_ENV]: '   ' });
    assert.strictEqual(blank.apiKey, KEY, 'a blank env value is unset, not a blank credential');
    assert.strictEqual(blank.keySource, 'config');

    const none = resolveProviderSettings({ baseUrl: 'http://127.0.0.1:11434/v1' }, {});
    assert.strictEqual(none.apiKey, undefined);
    assert.strictEqual(none.keySource, 'none');
  });

  test('a missing endpoint says what to run', () => {
    assert.throws(
      () => resolveProviderSettings({}, {}),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.strictEqual(err.kind, 'config');
        assert.match(err.message, /set-base-url/);
        return true;
      }
    );
  });

  test('plain HTTP is allowed only where the token cannot leave the machine', () => {
    for (const ok of ['http://localhost:11434/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:3000/v1']) {
      assert.doesNotThrow(() => normalizeProviderEndpoint(ok), `${ok} is loopback`);
    }
    for (const refused of [
      'http://gw.example/v1',
      'http://example.com',
      'http://10.0.0.5/v1',
      'http://evil.localhost/v1',
      'http://127.0.0.1.nip.io/v1',
    ]) {
      assert.throws(
        () => normalizeProviderEndpoint(refused),
        (err: unknown) => {
          assert.ok(err instanceof ProviderError && err.kind === 'config');
          assert.match(err.message, /clear text|https/i);
          return true;
        },
        `${refused} must not be permitted to send a bearer token in the open`
      );
    }
  });

  test('the loopback rule reads the same address the socket will connect to', () => {
    // Measured against Node's URL parser: every numeric IPv4 spelling it accepts is
    // canonicalised to a dotted quad before this rule sees it, so `127.1`, the hex and
    // octal forms, and the bare decimal all arrive as `127.0.0.1`. That is the property
    // worth pinning — the gate and the connection cannot disagree about the host, which
    // is how a security check normally becomes decoration.
    for (const spelling of ['http://127.1/v1', 'http://0x7f000001/v1', 'http://017700000001/v1', 'http://2130706433/v1']) {
      assert.strictEqual(normalizeProviderEndpoint(spelling).hostname, '127.0.0.1', spelling);
    }
    assert.strictEqual(normalizeProviderEndpoint('http://127.0.0.2/v1').hostname, '127.0.0.2', 'the whole 127/8 is loopback');
    assert.strictEqual(normalizeProviderEndpoint('http://[::1]:11434/v1').hostname, '[::1]');

    // Names are the other case, and they are refused rather than resolved: `nip.io` and
    // friends *do* answer with 127.0.0.1, but deciding a security property on a DNS
    // answer this client cannot see would make the check depend on what the resolver says
    // later. Same for `app.localhost`, which some resolvers answer and some do not.
    assert.throws(() => normalizeProviderEndpoint('http://127.0.0.1.nip.io/v1'), /clear text|https/i);
    assert.throws(() => normalizeProviderEndpoint('http://app.localhost/v1'), /clear text|https/i);
    assert.strictEqual(normalizeProviderEndpoint('http://localhost:11434/v1').hostname, 'localhost');
  });

  test('reserved address space is refused by shape, never by the start of a name', () => {
    // A reviewer asked for a URL allowlist. That would break "bring your own endpoint",
    // which the spec states as the design; the part worth honouring is the surprising
    // target, so link-local, unspecified, multicast and special-use names are refused
    // whatever scheme they arrive under. `169.254.169.254` is the cloud metadata service,
    // and a `test-connection` pointed at it is a probe of the host's own network.
    for (const refused of [
      'https://169.254.169.254/v1',
      'https://169.254.10.10/v1',
      'https://0.0.0.0/v1',
      'https://239.255.255.250/v1',
      'https://[fe80::1]/v1',
      'https://[fd00::1]/v1',
      // fe80::/10 is the whole range, not the `fe80` literal: the prefix bits run to febf.
      'https://[fe90::1]/v1',
      'https://[fea1::2]/v1',
      'https://[febf::]/v1',
      'https://[ff02::1]/v1',
      // IPv4-mapped literals must be judged as the addresses they encode. Node hands the
      // checker `[::ffff:a9fe:a9fe]`, never the dotted spelling a rule would match naively.
      'https://[::ffff:a9fe:a9fe]/v1',
      'https://[::ffff:169.254.169.254]/v1',
      'https://metadata.google.internal/v1',
    ]) {
      assert.throws(() => normalizeProviderEndpoint(refused), /reserved address space/, refused);
    }
    for (const allowed of [
      'https://169.254.example.com/v1',
      'https://224.example.com/v1',
      'https://api.internal-host.example/v1',
      'http://127.0.0.1:11434/v1',
      // `::1` is loopback and has to stay usable for a local provider on an IPv6 stack.
      'http://[::1]:11434/v1',
      // Public and documentation space, and the retired fec0 site-local range, which
      // fe80::/10 does not include.
      'https://[2001:db8::1]/v1',
      'https://[fec0::1]/v1',
      // A mapped literal that encodes a public address is not reserved either.
      'https://[::ffff:8.8.8.8]/v1',
    ]) {
      assert.doesNotThrow(() => normalizeProviderEndpoint(allowed), `${allowed} should not be refused`);
    }
  });

  test('a credential, query or fragment inside the base URL is refused, not folded into the path', () => {
    // Before this rule existed, `https://h/v1?token=x` produced
    // `https://h/v1?token=x/chat/completions`: a broken URL that no error message
    // explains, and a secret stored where `config show` would print it.
    assert.throws(() => normalizeProviderEndpoint('https://user:pw@gw.example/v1'), /username or password/);
    assert.throws(() => normalizeProviderEndpoint('https://gw.example/v1?token=abc'), /query string/);
    assert.throws(() => normalizeProviderEndpoint('https://gw.example/v1#frag'), /fragment/);
  });

  test('a native-Anthropic configuration is refused instead of spoken to with the wrong protocol', () => {
    // Silent fallback would present as "your key does not work", sending the user to the
    // wrong fix. The deferral is the spec's own (Decision 2).
    assert.throws(
      () => resolveProviderSettings({ baseUrl: 'https://api.anthropic.com', aiProvider: 'anthropic' }, {}),
      /Phase 3/
    );
    assert.doesNotThrow(() => resolveProviderSettings({ baseUrl: 'https://opencode.ai/zen/v1', aiProvider: 'opencode' }, {}));
  });

  test('a control character in a model name is refused before it reaches a wire or a log', () => {
    assert.throws(
      () => resolveProviderSettings({ baseUrl: 'https://h/v1', model: 'gpt-4\u001b[2J' }, {}),
      (err: unknown) => err instanceof ProviderError && err.kind === 'config'
    );
  });

  test('isLoopbackHost fails closed on spellings that are ambiguous by resolver', () => {
    assert.strictEqual(isLoopbackHost('localhost'), true);
    assert.strictEqual(isLoopbackHost('LOCALHOST'), true);
    assert.strictEqual(isLoopbackHost('127.0.0.1'), true);
    assert.strictEqual(isLoopbackHost('::1'), true);
    assert.strictEqual(isLoopbackHost('127.4.5.6'), true);
    assert.strictEqual(isLoopbackHost('127.1'), false, 'a shorthand that some stacks resolve and others do not');
    assert.strictEqual(isLoopbackHost('app.localhost'), false, 'suffix resolution is a platform choice');
    assert.strictEqual(isLoopbackHost('0x7f000001'), false);
    assert.strictEqual(isLoopbackHost('169.254.169.254'), false, 'the cloud metadata address');
  });
});

describe('provider request shape (#24)', () => {
  test('the chat-completions path is appended once, whatever the base looked like', () => {
    for (const [base, expected] of [
      ['https://gw.example/v1', 'https://gw.example/v1/chat/completions'],
      ['https://gw.example/v1/', 'https://gw.example/v1/chat/completions'],
      ['https://gw.example/v1/chat/completions', 'https://gw.example/v1/chat/completions'],
      ['https://gw.example', 'https://gw.example/chat/completions'],
      ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1/chat/completions'],
    ] as const) {
      const p = new OpenAICompatibleProvider(
        resolveProviderSettings({ baseUrl: base, apiKey: KEY }, {}),
        { transport: async () => completion('ok') }
      );
      assert.strictEqual(p.url, expected, `${base} -> ${expected}`);
    }
  });

  test('headers, model and messages are what the caller configured, and nothing else', async () => {
    const { p, calls } = providerFor(() => completion('ok'));
    await p.complete({ messages: [{ role: 'user', content: 'explain closures' }], temperature: 0.2 });
    assert.strictEqual(calls.length, 1);
    const [call] = calls;
    assert.strictEqual(call.headers.authorization, `Bearer ${KEY}`);
    assert.strictEqual(call.headers['content-type'], 'application/json');
    assert.strictEqual(call.body.model, DEFAULT_MODEL);
    assert.deepStrictEqual(call.body.messages, [{ role: 'user', content: 'explain closures' }]);
    assert.strictEqual(call.body.temperature, 0.2);
    assert.ok(!('max_tokens' in call.body), 'max_tokens is opt-in: newer endpoints reject it outright');
    assert.ok(!('response_format' in call.body));
  });

  test('no key means no authorization header at all', async () => {
    const { transport, calls } = recorder(() => completion('ok'));
    const p = new OpenAICompatibleProvider(
      resolveProviderSettings({ baseUrl: 'http://127.0.0.1:11434/v1' }, {}),
      { transport }
    );
    await p.complete({ messages: [{ role: 'user', content: 'ping' }] });
    assert.ok(!('authorization' in calls[0].headers), 'a local server is not sent an empty bearer');
  });

  test('a key carrying a control character is a config error, and nothing is sent', async () => {
    // A pasted trailing newline or an embedded control byte would otherwise land in the
    // Authorization header and come back as an opaque transport "network" error. It is a
    // configuration problem, named as one, before any socket is opened.
    for (const bad of [`${KEY}\n`, `${KEY}\x01more`]) {
      const { transport, calls } = recorder(() => completion('ok'));
      const p = new OpenAICompatibleProvider(settings({ apiKey: bad }), { transport });
      await assert.rejects(
        () => p.complete({ messages: [{ role: 'user', content: 'x' }] }),
        (err: unknown) => {
          assert.ok(err instanceof ProviderError && err.kind === 'config');
          assert.ok(!err.message.includes(bad), 'the key must not be echoed');
          assert.ok(!err.message.includes(KEY), 'not even the valid prefix of the key');
          return true;
        }
      );
      assert.strictEqual(calls.length, 0, 'a malformed key never reaches the wire');
    }
  });

  test('INV-37: no tool or function surface is ever sent', async () => {
    const { p, calls } = providerFor(() => completion('{"a":1}'));
    await p.complete({ messages: [{ role: 'user', content: 'json please' }], expectJson: true });
    for (const key of ['tools', 'tool_choice', 'functions', 'function_call']) {
      assert.ok(!(key in calls[0].body), `${key} must never appear in a PALEE request`);
    }
  });

  test('JSON mode adds the word the wire format requires, and only when it is missing', async () => {
    // Verified endpoint behaviour: `response_format: json_object` without "json" in the
    // messages is a 400, so the requirement is met by construction rather than by trusting
    // every future prompt author to write it.
    const { p, calls } = providerFor(() => completion('{"ok":true}'));
    await p.complete({ messages: [{ role: 'user', content: 'grade this note' }], expectJson: true });
    const sent = calls[0].body.messages as Array<{ role: string; content: string }>;
    assert.strictEqual(sent[0].role, 'system');
    assert.match(JSON.stringify(sent), /json/i);

    const said = providerFor(() => completion('{"ok":true}'));
    await said.p.complete({ messages: [{ role: 'user', content: 'Answer as JSON.' }], expectJson: true });
    assert.strictEqual(said.calls.length, 1);
    assert.deepStrictEqual(said.calls[0].body.messages, [{ role: 'user', content: 'Answer as JSON.' }], 'no duplicate instruction');
  });

  test('redirects are refused rather than followed with the credential attached', async () => {
    const { p, calls } = providerFor(() => completion('ok'));
    await p.complete({ messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(calls[0].init.redirect, 'error');
  });

  test('a request that never answers is bounded by the timeout and reported as unreachable', async () => {
    const { transport } = recorder(
      () => new Promise<Response>((_resolve, reject) => {
        // The fake waits for the abort this module raises, exactly as fetch would.
        setTimeout(() => reject(new Error('abandoned')), 5);
      })
    );
    const p = new OpenAICompatibleProvider(settings(), { transport, timeoutMs: 5 });
    await assert.rejects(
      () => p.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError && err.kind === 'network');
        assert.match(err.message, /within 5 ms/);
        return true;
      }
    );
  });

  test('a caller abort is reported as a cancellation, not as a timeout', async () => {
    const controller = new AbortController();
    const { transport } = recorder(
      (_call, init) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })
    );
    const p = new OpenAICompatibleProvider(settings(), { transport, timeoutMs: 60_000, signal: controller.signal });
    const running = p.complete({ messages: [{ role: 'user', content: 'x' }] });
    controller.abort();
    await assert.rejects(
      () => running,
      (err: unknown) => {
        assert.ok(err instanceof ProviderError && err.kind === 'network');
        assert.match(err.message, /cancelled/);
        return true;
      }
    );
  });
});

describe('provider reply handling (#24)', () => {
  test('the byte bound stops the read instead of measuring what was already buffered', async () => {
    // The first version read `response.text()` and *then* compared the length, which
    // describes the error message rather than the exposure: an endless stream was fully
    // allocated before anything was refused. This asserts the bound is enforced while
    // reading, using a source that never ends and would otherwise never resolve.
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { p } = providerFor(() => new Response(stream, { status: 500 }));
    await assert.rejects(
      () => p.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError && err.kind === 'provider');
        assert.match(err.message, /exceeded \d+ bytes/);
        return true;
      }
    );
    assert.ok(cancelled, 'the reader must be cancelled so the stream stops producing');
    assert.ok(pulls <= 10, `read a bounded number of chunks, pulled ${pulls}`);
  });

  test('a multi-byte character split across chunks survives the read', async () => {
    // Concatenate-then-decode is why the incremental reader collects chunks instead of
    // decoding each one: a boundary falling inside a three-byte sequence would otherwise
    // come back as replacement characters in the middle of a reply.
    const bytes = Buffer.from(JSON.stringify({ choices: [{ message: { content: '完成 ✅' } }] }), 'utf8');
    const split = bytes.indexOf(0xe2) + 1;
    const { p } = providerFor(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, split));
          controller.enqueue(bytes.subarray(split));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const reply = await p.complete({ messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(reply.text, '完成 ✅');
  });

  test('a normal completion returns the message text and the token accounting', async () => {
    const { p } = providerFor(() =>
      jsonResponse({
        choices: [{ message: { content: '  the answer  ' } }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      })
    );
    const reply = await p.complete({ messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(reply.text, '  the answer  ', 'model text is not rewritten');
    assert.deepStrictEqual(reply.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  });

  test('a content parts array is read as one message', async () => {
    const { p } = providerFor(() => completion([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]));
    const reply = await p.complete({ messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(reply.text, 'ab');
  });

  test('a 200 carrying an error body is a provider failure, not a schema failure', async () => {
    // Gateways do this: OpenRouter and vLLM-compatible proxies answer 200 with
    // {"error": ...}. Calling that malformed output sends the user to fix a prompt that
    // was never the problem.
    const { p } = providerFor(() => jsonResponse({ error: { message: 'invalid api key' } }));
    await assert.rejects(
      () => p.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError && err.kind === 'provider');
        assert.strictEqual(err.status, 200);
        assert.match(err.message, /invalid api key/);
        return true;
      }
    );
  });

  test('an empty message caused by a token cap says so', async () => {
    const { p } = providerFor(() => completion('', { finish_reason: 'length' }));
    await assert.rejects(
      () => p.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => err instanceof ProviderError && err.kind === 'schema' && /ran out of tokens/.test(err.message)
    );
  });

  test('an empty or absent choices array is the "no content" schema failure, not the empty-string one', async () => {
    // Distinct from the empty-string branch above: there a choice exists and its content is
    // '', here no choice (or no choices key) is present at all, so extraction returns
    // undefined and the adapter must name that rather than report an empty message.
    for (const payload of [{ choices: [] }, {}]) {
      const { p } = providerFor(() => jsonResponse(payload));
      await assert.rejects(
        () => p.complete({ messages: [{ role: 'user', content: 'x' }] }),
        (err: unknown) => {
          assert.ok(err instanceof ProviderError && err.kind === 'schema');
          assert.match(err.message, /no assistant message content/);
          return true;
        }
      );
    }
  });

  test('a non-2xx keeps its status and truncates the body safely', async () => {
    const long = 'x'.repeat(5_000);
    const { p } = providerFor(() => new Response(long, { status: 503 }));
    await assert.rejects(
      () => p.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError && err.kind === 'provider');
        assert.strictEqual(err.status, 503, 'a caller needs the status to tell 401 from 429');
        assert.ok(err.message.length < 1_000, 'the body is summarised, not pasted');
        return true;
      }
    );
  });

  test('a body larger than the read bound is refused', async () => {
    const huge = 'y'.repeat(MAX_RESPONSE_BYTES + 16);
    const { p } = providerFor(() => new Response(huge, { status: 500 }));
    await assert.rejects(
      () => p.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => err instanceof ProviderError && /bytes/.test(err.message)
    );
  });

  test('a non-JSON success body is a schema failure', async () => {
    const { p } = providerFor(() => new Response('<html>gateway login page</html>', { status: 200 }));
    await assert.rejects(
      () => p.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => err instanceof ProviderError && err.kind === 'schema'
    );
  });
});

describe('structured output contract: INV-38/39/40 (#24)', () => {
  test('valid JSON parses and costs exactly one request', async () => {
    const { p, calls } = providerFor(() => completion('{"verdict":"stale","confidence":0.8}'));
    const reply = await p.complete({ messages: [{ role: 'user', content: 'answer in json' }], expectJson: true });
    assert.deepStrictEqual(reply.json, { verdict: 'stale', confidence: 0.8 });
    assert.strictEqual(calls.length, 1);
  });

  test('a fenced reply is rejected after one retry, never unwrapped', async () => {
    // INV-40: fenced, repaired or regex-extracted JSON is never executed. A repairer here
    // would quietly accept output from a model that did not follow the contract.
    const { p, calls } = providerFor(() => completion('```json\n{"a":1}\n```'));
    await assert.rejects(
      () => p.complete({ messages: [{ role: 'user', content: 'json please' }], expectJson: true }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError && err.kind === 'schema');
        assert.match(err.message, /fenced code block/);
        assert.match(err.message, /was not used/);
        return true;
      }
    );
    assert.strictEqual(calls.length, 2, 'INV-39: at most one retry');
  });

  test('prose around the object is rejected; the object is not extracted from it', async () => {
    const { p } = providerFor(() => completion('Sure! Here it is: {"a":1}'));
    await assert.rejects(
      () => p.complete({ messages: [{ role: 'user', content: 'json please' }], expectJson: true }),
      (err: unknown) => err instanceof ProviderError && err.kind === 'schema'
    );
  });

  test('a second reply that is valid is accepted', async () => {
    let call = 0;
    const { p, calls } = providerFor(() => {
      call++;
      return completion(call === 1 ? 'not json' : '{"a":1}');
    });
    const reply = await p.complete({ messages: [{ role: 'user', content: 'json please' }], expectJson: true });
    assert.deepStrictEqual(reply.json, { a: 1 });
    assert.strictEqual(calls.length, 2);
  });

  test('a retry that fails at the provider keeps that failure kind and status', async () => {
    // Laundering a 401 into `network` here would cost the user the one fact that matters.
    let call = 0;
    const { p } = providerFor(() => {
      call++;
      return call === 1 ? completion('prose') : new Response('unauthorized', { status: 401 });
    });
    await assert.rejects(
      () => p.complete({ messages: [{ role: 'user', content: 'json please' }], expectJson: true }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.strictEqual(err.kind, 'provider');
        assert.strictEqual(err.status, 401);
        assert.match(err.message, /the retry failed/);
        return true;
      }
    );
  });

  test('expectJson does not request JSON when the caller did not ask for it', async () => {
    const { p, calls } = providerFor(() => completion('plain prose is fine here'));
    const reply: ChatReply = await p.complete({ messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(reply.text, 'plain prose is fine here');
    assert.strictEqual(reply.json, undefined);
    assert.strictEqual(calls.length, 1, 'no retry for a reply nobody constrained');
  });
});

describe('redaction of every foreign string (#24)', () => {
  test('describeForeignText masks before it truncates', () => {
    const key = 'testkey-abcdefghij0123456789';
    const echoing = `${'noise '.repeat(80)}${key} trailing`;
    const described = describeForeignText(key, echoing);
    assert.ok(!described.includes(key.slice(0, 12)), 'a fragment of the key must not survive the cut');
    assert.ok(!described.includes(key));

    const straddling = `${'z'.repeat(MAX_MESSAGE_CHARS - 4)}${key}`;
    assert.ok(!describeForeignText(key, straddling).includes(key.slice(0, 8)));
  });

  test('an ANSI escape from a provider body cannot forge terminal output (INV-30)', () => {
    const described = describeForeignText(undefined, 'done\u001b[2J\u001b]0;pwned\u0007');
    // ESC is not whitespace: collapsing whitespace alone would leave the sequence intact.
    assert.ok(!described.includes('\u001b'), described);
    assert.ok(!described.includes('\u0007'), described);
  });

  test('a provider echoing the key in a 4xx body is reported without it', async () => {
    const { p } = providerFor(() => new Response(`auth failed for ${KEY}`, { status: 401 }));
    await assert.rejects(
      () => p.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.ok(!err.message.includes(KEY), err.message);
        assert.match(err.message, /\*\*\*/);
        return true;
      }
    );
  });

  test('model output that repeats the key is masked on the success path', async () => {
    // `config show` redaction cannot cover this: the key arrives inside a reply the CLI
    // is about to print.
    const { p } = providerFor(() => completion(`your key is ${KEY}`));
    const reply = await p.complete({ messages: [{ role: 'user', content: 'x' }] });
    assert.ok(!reply.text.includes(KEY), reply.text);
    assert.match(reply.text, /your key is \*\*\*/);
  });

  test('a transport exception message is never forwarded verbatim', async () => {
    const { transport } = recorder(() => {
      throw new TypeError(`connect ${KEY} refused`);
    });
    const p = new OpenAICompatibleProvider(settings(), { transport });
    await assert.rejects(
      () => p.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError && err.kind === 'network');
        assert.ok(!err.message.includes(KEY), err.message);
        return true;
      }
    );
  });

  test('a hand-built settings object cannot smuggle an unsafe endpoint past the constructor', () => {
    const bad = { baseUrl: 'http://public.example/v1', model: 'm', keySource: 'none' as const };
    assert.throws(
      () => new OpenAICompatibleProvider(bad, { transport: async () => completion('x') }),
      (err: unknown) => err instanceof ProviderError && err.kind === 'config'
    );
  });
});
