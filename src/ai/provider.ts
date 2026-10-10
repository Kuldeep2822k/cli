/**
 * AI Provider Abstraction (#24)
 *
 * The only place in `src/` that opens a network socket. Everything else in PALEE is
 * deterministic and offline (INV-29), and that boundary is held by
 * `test/ai-network-boundary.test.ts`, which fails if a `fetch`, `http.request` or `dns`
 * call appears anywhere outside this module. A comment cannot keep INV-29 true; a test can.
 *
 * One adapter exists — OpenAI-compatible chat completions — because the spec defers
 * native Anthropic to Phase 3 (`planning/palee_cli_spec.md` Decision 2: "the tool-calling
 * contract is identical and adding a second provider adapter mid-build adds risk"). #24
 * also asks for capability *detection*; that is not implemented and is not claimed here.
 * What is fixed are this adapter's own facts: it does not stream, and it never sends a
 * tool or function definition (INV-37).
 */

import { PaleeConfig } from '../types';

/** Why a provider call failed, so the CLI maps it through `exitCodeFor()` exactly once. */
export type ProviderErrorKind = 'config' | 'network' | 'provider' | 'schema';

/**
 * A provider failure that carries its classification and, when there was one, the HTTP status.
 *
 * @remarks
 * Both survive every path. The retry branch used to relabel any second failure as
 * `network`, which turned a `401` into an I/O error and dropped the status a caller
 * would need to tell "bad credential" from "endpoint unreachable".
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;

  constructor(kind: ProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
  }
}

/** One turn of a chat conversation. */
export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** What the caller asked the model for. */
export interface ChatRequest {
  messages: ChatTurn[];
  /**
   * Require the reply to be one complete JSON document.
   *
   * @remarks
   * When set and no message mentions JSON, a system turn is added for the caller: an
   * OpenAI-compatible endpoint answers `response_format: json_object` with HTTP 400
   * unless the word "json" appears in the messages, so the requirement is satisfied
   * rather than trusted to whoever wrote the prompt.
   */
  expectJson?: boolean;
  temperature?: number;
  /**
   * Sent as `max_tokens`, which newer OpenAI reasoning models reject in favour of
   * `max_completion_tokens`. Leave unset unless the target deployment accepts it.
   */
  maxTokens?: number;
}

/** Token accounting, when the gateway reports it. */
export interface UsageCounts {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** The provider's answer. */
export interface ChatReply {
  text: string;
  /** Present only when `expectJson` was set and the text parsed as JSON. */
  json?: unknown;
  usage?: UsageCounts;
}

/**
 * The seam every network call goes through.
 *
 * @remarks
 * No test in this repository may reach an external host, so the transport is injected
 * instead of hardcoded to the global `fetch`. This is what makes URL building, header
 * assembly, redirect refusal, retry counting and redaction testable rather than assumed.
 */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Where the credential came from, so a user is told which one is in play.
 * `none` is legal: a loopback server may need no key.
 */
export type KeySource = 'env' | 'config' | 'none';

/** Connection settings, resolved from config and environment. */
export interface ProviderSettings {
  baseUrl: string;
  model: string;
  apiKey?: string;
  keySource: KeySource;
  providerName?: string;
}

/** Options for one provider instance. */
export interface ProviderOptions {
  transport?: Transport;
  /** Wall-clock budget for a single request. Default {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Environment the credential override is read from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Cancels an in-flight request. A long audit run needs this: without it, ctrl-c still
   * waits out `timeoutMs` for every request already sent.
   */
  signal?: AbortSignal;
}

/** No request waits forever, and a local model on a loaded laptop is not a fast API. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** The environment variable that supplies the credential without touching disk. */
export const API_KEY_ENV = 'PALEE_API_KEY';

/** Bound on what this client will read from a foreign endpoint. */
export const MAX_RESPONSE_BYTES = 256 * 1024;

/** Longest foreign text that reaches an error message. */
export const MAX_MESSAGE_CHARS = 300;

/** Used only when no model is configured; matches the spec's recommended free tier. */
export const DEFAULT_MODEL = 'nemotron-3-ultra-free';

/**
 * Provider names this build cannot serve.
 *
 * @remarks
 * Everything else is treated as OpenAI-compatible, which is right for the endpoints the
 * docs recommend and for vendors exposing a compatibility layer. `anthropic` is refused
 * rather than spoken to with the wrong protocol — that failure would otherwise read to
 * the user as a bad credential.
 */
const DEFERRED_PROVIDERS = new Set(['anthropic']);

/**
 * True only for hosts that cannot leave the machine.
 *
 * @param hostname - A `URL.hostname` value (lowercased, brackets removed)
 * @returns Whether plain HTTP is acceptable for it
 *
 * @remarks
 * The value arriving here has already been through the URL parser, which is the point:
 * every numeric IPv4 spelling it accepts — `127.1`, `0x7f000001`, `017700000001`,
 * `2130706433` — arrives as `127.0.0.1`, so this rule and the eventual connection cannot
 * disagree about which host they mean. Name forms are refused rather than looked up.
 * That is deliberately conservative: `127.0.0.1.nip.io` really does resolve to loopback
 * and `anything.localhost` does on some platforms, but deciding a clear-text permission
 * on what a resolver will say later is not a check this client can make, and `0.0.0.0`
 * (what a bare `0` parses to) is a bind address, not a loopback one.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  return /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Prepares text that came from outside this process for use in a message.
 *
 * @param secret - The credential, when one is configured
 * @param text - Foreign text: a response body, an exception message, anything
 * @returns Redacted, control-character-free, length-bounded text
 *
 * @remarks
 * The order is the whole point. Redaction runs **before** truncation: slice first and a
 * key straddling the cut survives as a fragment that no later `split(secret)` can match.
 * Control characters are stripped next — an ANSI escape is not whitespace, so
 * collapsing whitespace alone still lets a provider body forge terminal output and
 * cursor moves (INV-30). Finally the length bound.
 */
export function describeForeignText(secret: string | undefined, text: string): string {
  const masked = secret && secret.length > 0 ? text.split(secret).join('***') : text;
  const printable = masked
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '?')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return printable.length > MAX_MESSAGE_CHARS ? `${printable.slice(0, MAX_MESSAGE_CHARS)}…` : printable;
}

/** The IPv4 rules, applied to a dotted-quad string. Never by name prefix. */
function isReservedIPv4(host: string): boolean {
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!quad) return false;
  const first = Number(quad[1]);
  if (first === 0) return true;
  if (first === 169 && Number(quad[2]) === 254) return true;
  return first >= 224;
}

/**
 * The dotted quad inside an IPv4-mapped IPv6 literal, if the host is one.
 *
 * @param bare - An IPv6 host with its brackets already removed
 * @returns The embedded address as a dotted quad, or `undefined`
 *
 * @remarks
 * Matched against Node's *serialised* form, which was measured rather than assumed:
 * `https://[::ffff:169.254.169.254]/` reaches `URL.hostname` as `[::ffff:a9fe:a9fe]`, not
 * as a dotted quad. A rule written against the spelling a caller types would never fire.
 */
function embeddedIPv4(bare: string): string | undefined {
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (!mapped) return undefined;
  const hi = Number.parseInt(mapped[1], 16);
  const lo = Number.parseInt(mapped[2], 16);
  return `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * True for address ranges that are never a provider endpoint.
 *
 * @param hostname - A `URL.hostname` value
 * @returns Whether the host must be refused whatever scheme it was configured with
 *
 * @remarks
 * A reviewer flagged this module's URL as an SSRF surface. An *allowlist* would break the
 * feature — the spec's whole premise is "bring your own OpenAI-compatible endpoint", and
 * the value being read is the user's own config, not an attacker's request. The part of
 * that concern worth honouring in code is the surprising target: a base URL that points at
 * link-local space reaches the cloud metadata service (`169.254.169.254`), and nothing
 * legitimate lives at the unspecified or multicast addresses. Those are refused outright,
 * over https included, so a mistyped or planted endpoint cannot turn a `test-connection`
 * into a probe of the host's own network.
 *
 * IPv6 is decided on the canonical hextet prefixes the serializer produces: link-local is
 * `fe80::/10`, which spans `fe80` through `febf` — not merely the `fe80` literal — while
 * `fec0` (the retired site-local range) stays outside the refusal. `fc00::/7` and
 * `ff00::/12` are unique-local and multicast. An IPv4-mapped literal is unwrapped and
 * judged by the IPv4 rules, so `[::ffff:a9fe:a9fe]` is the metadata address it encodes.
 * `::1` is exempt: it is loopback, and permitting it is what makes a local provider on
 * IPv6 usable over http.
 */
export function isReservedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.startsWith('[')) {
    const bare = host.slice(1, -1);
    if (bare === '::') return true;
    if (bare === '::1') return false;
    const embedded = embeddedIPv4(bare);
    if (embedded !== undefined) return isReservedIPv4(embedded);
    return /^fe[89ab]/.test(bare) || /^f[cd]/.test(bare) || /^ff/.test(bare);
  }
  // Matched by address shape, never by the start of a DNS name: `169.254.example.com` is a
  // hostname someone owns, `169.254.169.254` is the metadata service.
  if (isReservedIPv4(host)) return true;
  // RFC 6762 special-use suffix: cloud and corporate metadata endpoints are named, not just
  // numbered (`metadata.google.internal`).
  return host.endsWith('.internal');
}

/**
 * Validates a provider endpoint and returns it parsed.
 *
 * @param raw - The configured base URL
 * @returns The parsed URL, free of credentials, query and fragment
 * @throws {ProviderError} `kind: 'config'` for any rejected shape
 *
 * @remarks
 * This is the single rule for what a base URL may be. `palee config set-base-url` and
 * every request path go through it, so a stored value cannot pass one gate and fail the
 * other, and the same refusal cannot carry two different exit codes. Plain HTTP is
 * allowed only for a loopback host, because that request carries a bearer token.
 */
export function normalizeProviderEndpoint(raw: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new ProviderError('config', `Provider base URL is not a valid URL: ${describeForeignText(undefined, raw)}`);
  }
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    throw new ProviderError('config', `Provider base URL must be http or https, got ${endpoint.protocol}`);
  }
  if (isReservedHost(endpoint.hostname)) {
    throw new ProviderError(
      'config',
      `Provider base URL points at ${describeForeignText(undefined, endpoint.host)}, which is reserved ` +
        'address space (link-local, unspecified or multicast) — the cloud metadata service lives there, ' +
        'and no provider endpoint does.'
    );
  }
  if (endpoint.protocol === 'http:' && !isLoopbackHost(endpoint.hostname)) {
    throw new ProviderError(
      'config',
      `Refusing plain HTTP to ${describeForeignText(undefined, endpoint.host)}: the bearer token would ` +
        'travel in clear text. Use https, or point at a loopback address.'
    );
  }
  if (endpoint.username || endpoint.password) {
    throw new ProviderError(
      'config',
      'Provider base URL must not embed a username or password; set the credential with palee config set-api-key'
    );
  }
  if (endpoint.search || endpoint.hash) {
    throw new ProviderError(
      'config',
      'Provider base URL must not carry a query string or fragment; a key belongs in palee config set-api-key'
    );
  }
  return endpoint;
}

/** Appends the chat-completions path without doubling it or losing the configured prefix. */
function completionsUrl(endpoint: URL): string {
  const base = new URL(endpoint.toString());
  const path = base.pathname.replace(/\/+$/, '');
  base.pathname = /\/chat\/completions$/.test(path) ? path : `${path}/chat/completions`;
  base.search = '';
  base.hash = '';
  return base.toString();
}

/**
 * Resolves the settings a provider call should use.
 *
 * @param config - The loaded `PaleeConfig`
 * @param env - Environment for the credential override (default `process.env`)
 * @returns Resolved settings, with the endpoint already validated
 * @throws {ProviderError} `kind: 'config'`
 *
 * @remarks
 * `PALEE_API_KEY` outranks the stored key, so a user who never wants the secret on disk
 * has a supported route to that, and CI can inject one without writing a config file.
 * Which source won is reported through `keySource`; a whitespace-only environment value
 * counts as unset rather than as a blank credential.
 */
export function resolveProviderSettings(
  config: PaleeConfig,
  env: Record<string, string | undefined> = process.env
): ProviderSettings {
  if (!config.baseUrl) {
    throw new ProviderError('config', 'No provider endpoint configured. Run: palee config set-base-url <url>');
  }
  const endpoint = normalizeProviderEndpoint(config.baseUrl);

  if (config.model && !isSendable(config.model)) {
    throw new ProviderError('config', 'Model name contains characters that cannot be sent to a provider');
  }
  const providerName = config.aiProvider?.trim();
  if (providerName && DEFERRED_PROVIDERS.has(providerName.toLowerCase())) {
    throw new ProviderError(
      'config',
      `Provider "${providerName}" is not supported yet: native Anthropic is Phase 3. ` +
        'Configure an OpenAI-compatible endpoint instead.'
    );
  }

  const fromEnv = env[API_KEY_ENV]?.trim();
  const apiKey = fromEnv || config.apiKey;

  return {
    baseUrl: endpoint.origin + endpoint.pathname.replace(/\/+$/, ''),
    model: config.model?.trim() || DEFAULT_MODEL,
    apiKey,
    keySource: fromEnv ? 'env' : config.apiKey ? 'config' : 'none',
    providerName,
  };
}

/** Printable ASCII only: a control character in a field that reaches a wire or a log is a forgery vector. */
function isSendable(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

/** Adds the JSON instruction the wire format requires, unless the prompt already says it. */
function messagesFor(request: ChatRequest): ChatTurn[] {
  if (!request.expectJson) return request.messages;
  if (request.messages.some((turn) => /json/i.test(turn.content))) return request.messages;
  return [
    { role: 'system', content: 'Respond with a single JSON object and no other text.' },
    ...request.messages,
  ];
}

/**
 * One OpenAI-compatible chat-completions endpoint.
 *
 * @example
 * ```typescript
 * const provider = OpenAICompatibleProvider.forConfig(loadConfig());
 * const reply = await provider.complete({ messages: [{ role: 'user', content: 'ping' }] });
 * ```
 */
export class OpenAICompatibleProvider {
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private readonly callerSignal?: AbortSignal;
  private readonly requestUrl: string;
  private readonly host: string;

  constructor(
    private readonly settings: ProviderSettings,
    options: ProviderOptions = {}
  ) {
    // Validated here as well as at resolution: a caller that builds settings by hand
    // must not get an unchecked URL into the socket layer.
    const endpoint = normalizeProviderEndpoint(settings.baseUrl);
    this.requestUrl = completionsUrl(endpoint);
    this.host = describeForeignText(settings.apiKey, endpoint.host);
    this.transport = options.transport ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.callerSignal = options.signal;
  }

  /** Resolves settings from a config object and builds the provider for them. */
  static forConfig(
    config: PaleeConfig,
    options: ProviderOptions = {}
  ): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider(resolveProviderSettings(config, options.env), options);
  }

  /** The exact URL that will be called, so a 404 can be read as a base-URL mistake. */
  get url(): string {
    return this.requestUrl;
  }

  get model(): string {
    return this.settings.model;
  }

  /**
   * Sends one chat completion and returns the assistant's message.
   *
   * @param request - The turns, and whether a JSON document is required
   * @returns The reply text, parsed when `expectJson` was asked for
   * @throws {ProviderError} `config`, `network`, `provider`, or `schema`
   *
   * @remarks
   * With `expectJson` the reply must be one complete JSON document after trimming. A
   * fenced block, an object wrapped in prose, or a regex-extracted `{...}` is never
   * repaired — INV-40 makes recovered JSON a rejection, because a model that could not
   * meet the output contract is exactly the one whose content should not be trusted.
   * INV-39 grants one retry and only one, issued as a fresh request rather than a second
   * parse of the same text.
   *
   * The returned text is redacted for the configured credential. An echo-back gateway
   * would otherwise print the key through the success path, which no `config show`
   * redaction can cover.
   */
  async complete(request: ChatRequest): Promise<ChatReply> {
    const first = await this.attempt(request);
    if (!request.expectJson) return this.redeemed(first);

    const parsed = tryParseJson(first.text);
    if (parsed.ok) return { ...this.redeemed(first), json: parsed.value };

    let second: ChatReply;
    try {
      second = await this.attempt(request);
    } catch (err) {
      if (err instanceof ProviderError) {
        // Keep the second failure's own kind and status: it is the truer report, and a
        // 401 or 429 here must not be laundered into a generic network error.
        throw new ProviderError(
          err.kind,
          `${parsed.reason}; the retry failed instead: ${err.message}`,
          err.status
        );
      }
      throw err;
    }

    const reparsed = tryParseJson(second.text);
    if (reparsed.ok) return { ...this.redeemed(second), json: reparsed.value };
    throw new ProviderError(
      'schema',
      `${parsed.reason}, and again after one retry: ${reparsed.reason}. The reply was not used.`
    );
  }

  /** Masks the credential in model output; leaves everything else byte-for-byte alone. */
  private redeemed(reply: ChatReply): ChatReply {
    return { ...reply, text: maskSecret(this.settings.apiKey, reply.text) };
  }

  /** One HTTP round trip. No retry logic lives here. */
  private async attempt(request: ChatRequest): Promise<ChatReply> {
    const { apiKey } = this.settings;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const body: Record<string, unknown> = {
      model: this.settings.model,
      messages: messagesFor(request),
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.expectJson) body.response_format = { type: 'json_object' };
    // INV-37: no `tools` and no `functions` are ever sent. The model is given no
    // executable surface, so assessment, review and session writes stay in the session
    // manager's own API rather than in something a remote reply can steer.

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onCallerAbort = (): void => controller.abort();
    this.callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    let response: Response;
    try {
      response = await this.transport(this.requestUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        // A redirect would re-send the bearer token to a host this validation never
        // saw, which is how an https-only rule ends up posting to anywhere.
        redirect: 'error',
      });
      return await this.readReply(response);
    } catch (err) {
      throw this.transportFailure(err, timedOut);
    } finally {
      clearTimeout(timer);
      this.callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /** Turns whatever the transport threw into a classified failure with no secrets in it. */
  private transportFailure(err: unknown, timedOut: boolean): ProviderError {
    if (err instanceof ProviderError) return err;
    const secret = this.settings.apiKey;
    if (this.callerSignal?.aborted) {
      return new ProviderError('network', `Request to ${this.host} was cancelled before it completed.`);
    }
    if (timedOut) {
      return new ProviderError(
        'network',
        `No response from ${this.host} within ${this.timeoutMs} ms.`
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    const redirected = /redirect/i.test(reason);
    return new ProviderError(
      'network',
      `Could not reach ${this.host}: ${describeForeignText(secret, reason)}` +
        (redirected ? ' (the provider redirected; PALEE does not follow redirects with a credential attached.)' : '')
    );
  }

  /** Reads and classifies one response. */
  private async readReply(response: Response): Promise<ChatReply> {
    const secret = this.settings.apiKey;
    const rawText = await readCapped(response, secret);

    if (!response.ok) {
      const snippet = describeForeignText(secret, rawText);
      throw new ProviderError(
        'provider',
        `Provider returned HTTP ${response.status} at ${this.url}${snippet ? `: ${snippet}` : '.'}`,
        response.status
      );
    }

    const envelope = tryParseJson(rawText);
    if (!envelope.ok) {
      throw new ProviderError(
        'schema',
        `Provider at ${this.url} replied with a body that is not JSON (${envelope.reason}).`
      );
    }
    const value = envelope.value as Record<string, unknown>;

    // Gateways routinely answer 200 with an error payload. Calling that a schema failure
    // would send the user to fix their prompt instead of their credential.
    const reported = value.error as { message?: unknown } | undefined;
    if (reported !== undefined) {
      const detail = describeForeignText(secret, typeof reported?.message === 'string' ? reported.message : JSON.stringify(reported));
      throw new ProviderError(
        'provider',
        `Provider at ${this.url} reported an error in a ${response.status} response${detail ? `: ${detail}` : '.'}`,
        response.status
      );
    }

    const content = extractContent(value);
    if (content === undefined) {
      throw new ProviderError('schema', `Provider at ${this.url} returned no assistant message content.`);
    }
    if (content.trim() === '') {
      throw new ProviderError(
        'schema',
        `Provider at ${this.url} returned an empty assistant message` +
          (extractFinishReason(value) === 'length' ? ' (it ran out of tokens).' : '.')
      );
    }
    const usage = extractUsage(value);
    return usage ? { text: content, usage } : { text: content };
  }
}

/** Masks every occurrence of the credential without otherwise altering the text. */
function maskSecret(secret: string | undefined, text: string): string {
  return secret && secret.length > 0 ? text.split(secret).join('***') : text;
}

/**
 * Reads a response body, refusing anything larger than {@link MAX_RESPONSE_BYTES}.
 *
 * @remarks
 * The bound is enforced *while reading*, not after. Measuring a fully buffered
 * `response.text()` would let an unbounded stream allocate freely and only then complain —
 * the cap would describe the error message rather than the exposure. Chunks are collected
 * until the limit is crossed, the reader is cancelled so the stream stops producing, and
 * only then is the failure raised; the decode happens once, at the end, so a multi-byte
 * character split across chunks is not corrupted.
 */
async function readCapped(response: Response, secret: string | undefined): Promise<string> {
  const tooBig = (): ProviderError =>
    new ProviderError(
      'provider',
      `Provider response exceeded ${MAX_RESPONSE_BYTES} bytes at ${describeForeignText(secret, response.url || 'unknown endpoint')}.`,
      response.status
    );

  const stream = response.body;
  if (!stream) {
    // A synthetic or already-consumed body: nothing to stream, so fall back to the
    // buffered read and still refuse an oversized payload.
    const buffered = await response.text();
    if (Buffer.byteLength(buffered, 'utf8') > MAX_RESPONSE_BYTES) throw tooBig();
    return buffered;
  }

  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  let overflow = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        overflow = true;
        break;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (overflow) await reader.cancel().catch(() => undefined);
  }

  if (overflow) throw tooBig();
  return Buffer.concat(chunks).toString('utf8');
}

/** Parses only a whole JSON document, and says why anything else was rejected. */
function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: 'the reply was empty' };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    const shape = trimmed.startsWith('```')
      ? 'it arrived inside a fenced code block'
      : trimmed.startsWith('{') || trimmed.startsWith('[')
        ? 'it began like JSON but did not parse as a complete document'
        : 'it was not JSON at all';
    return { ok: false, reason: `the reply was ${shape}` };
  }
}

/** Pulls the assistant message out of a chat-completions envelope. */
function extractContent(value: Record<string, unknown>): string | undefined {
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
  const content = first?.message?.content ?? first?.text;
  if (typeof content === 'string') return content;
  // Some gateways return content as a parts array. Concatenating the text parts keeps the
  // contract "the assistant said this" without accepting anything else about the shape.
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''
      )
      .join('');
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

/** `finish_reason`, when present, so truncation can be named instead of guessed. */
function extractFinishReason(value: Record<string, unknown>): string | undefined {
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const reason = (choices[0] as { finish_reason?: unknown })?.finish_reason;
  return typeof reason === 'string' ? reason : undefined;
}

/** Token counts, when the gateway reports them. */
function extractUsage(value: Record<string, unknown>): UsageCounts | undefined {
  const usage = value.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  const number = (key: string): number => {
    const raw = usage[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  };
  return {
    promptTokens: number('prompt_tokens'),
    completionTokens: number('completion_tokens'),
    totalTokens: number('total_tokens'),
  };
}
