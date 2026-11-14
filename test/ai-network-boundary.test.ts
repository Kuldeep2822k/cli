import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * INV-29 says non-AI commands open no network sockets. That is only a rule while there is
 * one place that can break it, and a comment cannot enforce that — this can. It reads the
 * shipped source tree the way `test/planning-invariant-ids.test.ts` and
 * `test/docs-command-matrix.test.ts` read theirs: no execution, no fixture, just the
 * structure the project has promised. Both roots the tarball executes are scanned —
 * `src/` and `bin/` (the entry point ships in the artifact too, so a socket there would
 * be just as real); `test/` is deliberately unscanned, because the suite legitimately
 * stubs `spawnSync` and imports `child_process` to do it.
 *
 * Two escape hatches reach a socket, and each is allowed in exactly one file:
 *  - a direct socket primitive — `fetch`, `http(s)`, `http2`, `net`, `tls`, `dgram`, DNS,
 *    the `WebSocket` global, and `undici` — allowed only in `src/ai/provider.ts`, the
 *    adapter that owns the timeout, redaction and cancel machinery (INV-29);
 *  - a child process, which opens sockets on PALEE's behalf — allowed only in
 *    `src/cli/update-check.ts`, the documented npm delegation of ADR-0033.
 * The provider adapter's exemption covers sockets it opens itself; handing work to a
 * child process is a different escape hatch and stays forbidden there.
 *
 * A child process is tracked by its import, not its call shape: every spawn must import
 * `child_process` first, and a call-form rule would false-positive on `RegExp.exec`.
 */
const root = path.resolve(__dirname, '..');

/** Every root the built artifact executes; a socket in either one is a real socket. */
const SCAN_ROOTS = ['src', 'bin'].map((dir) => path.join(root, dir));

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

/** The scanned files, as POSIX-style paths relative to the repo root. */
function scannedFiles(): string[] {
  return SCAN_ROOTS.flatMap((dir) => sourceFiles(dir)).map((file) =>
    path.relative(root, file).split(path.sep).join('/')
  );
}

/** The one file allowed to open a socket directly: the provider adapter (INV-29). */
const PROVIDER_ADAPTER = 'src/ai/provider.ts';
/** The one file allowed to spawn a child: the documented npm delegation (ADR-0033). */
const NPM_CHILD = 'src/cli/update-check.ts';

interface PrimitiveRule {
  /** What the offender line names, in the words the failure message reports. */
  label: string;
  /**
   * Call forms that can open a socket or resolve a name. Written as character classes
   * where it matters so this file does not match itself and quietly exempt the code
   * that is allowed to network.
   */
  pattern: RegExp;
  /** The single file allowed to use this primitive, if any. */
  allowedIn: string;
}

const SOCKET_RULES: Array<Omit<PrimitiveRule, 'allowedIn'>> = [
  { label: 'fetch()', pattern: /(^|[^.\w])fetch\s*\(/ },
  { label: 'http.request()', pattern: /\bhttps?\s*\.\s*request\s*\(/ },
  { label: 'http.get()', pattern: /\bhttps?\s*\.\s*get\s*\(/ },
  { label: 'an http2 session', pattern: /\bhttp2\s*\.\s*connect\s*\(/ },
  { label: 'a raw socket', pattern: /\bnet\s*\.\s*connect\s*\(/ },
  { label: 'a TLS socket', pattern: /\btls\s*\.\s*connect\s*\(/ },
  { label: 'a UDP socket', pattern: /\bdgram\s*\.\s*createSocket\s*\(/ },
  { label: 'a DNS lookup', pattern: /\bdns\s*\.\s*(lookup|resolve)/ },
  { label: 'a WebSocket', pattern: /\bnew\s+WebSocket\s*\(/ },
  {
    label: 'an import of net/tls/dns/http/https/http2/dgram/undici',
    pattern: /from\s+['"](?:node:)?(?:net|tls|dns|http|https|http2|dgram|undici)['"]/,
  },
];

/**
 * All rules, each with the one file that may use it. `undici` is named explicitly even
 * though Node's global `fetch` is undici-backed: `import { request } from 'undici'`
 * never spells `fetch(`.
 */
const RULES: PrimitiveRule[] = [
  ...SOCKET_RULES.map((rule) => ({ ...rule, allowedIn: PROVIDER_ADAPTER })),
  {
    label: 'an import of child_process (a socket opened by a child)',
    pattern: /from\s+['"](?:node:)?child_process['"]/,
    allowedIn: NPM_CHILD,
  },
];

/**
 * Every primitive use in the scanned roots. With `respectAllowlist` the two sanctioned
 * sites are exempted from exactly their own rules; without it, nothing is exempt — the
 * form the detection test reads to prove the rules still fire on the real code.
 */
function collectOffenders(respectAllowlist: boolean): string[] {
  const offenders: string[] = [];
  for (const rel of scannedFiles()) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const lines = text.split(/\r?\n/);
    for (const rule of RULES) {
      if (respectAllowlist && rule.allowedIn === rel) continue;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        assert.ok(line !== undefined);
        if (rule.pattern.test(line)) offenders.push(`${rel}:${index + 1} uses ${rule.label}`);
      }
    }
  }
  return offenders;
}

describe('INV-29 network boundary (#24)', () => {
  test('no source file outside the sanctioned sites can reach the network', () => {
    const offenders = collectOffenders(true);
    assert.deepStrictEqual(
      offenders,
      [],
      'INV-29: PALEE is offline by construction. A second socket site would need its own ' +
        'timeout, redaction, cancel and exit-code handling, and would silently widen the ' +
        'attack surface the provider adapter exists to concentrate. Sockets are allowed ' +
        `only in ${PROVIDER_ADAPTER}; the only indirect path is the npm child process of ` +
        `ADR-0033, allowed only in ${NPM_CHILD}.`
    );
  });

  test('the provider adapter is not part of the published library surface', () => {
    // `src/index.ts` is what `import { ... } from '@kuldeep2822k/palee'` exposes. Keeping
    // `ai` out of it means nothing that consumes PALEE as a library inherits a code path
    // that talks to a provider.
    const barrel = fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');
    assert.ok(!/from\s+['"]\.\/ai['"]/.test(barrel), 'src/index.ts must not re-export the AI subsystem');
  });

  test('the AI subsystem depends on types only, not on the CLI layer', () => {
    // The command handlers call the provider; the provider must never call back into a
    // command, or the seam that makes it testable turns into a cycle.
    for (const file of sourceFiles(path.join(root, 'src', 'ai'))) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!/from\s+['"][^'"]*cli\//.test(text), `${path.basename(file)} must not import from src/cli`);
    }
  });

  test('the guard scans every root the artifact executes, bin/ included', () => {
    // Reverting the scan to `src/` alone would leave the entry point — the one file
    // every shipped run executes — outside the boundary it advertises.
    const rels = scannedFiles();
    assert.ok(rels.includes(PROVIDER_ADAPTER), 'src/ is scanned');
    assert.ok(rels.includes('bin/palee.ts'), 'bin/ is scanned: the entry point ships in the tarball too');
  });

  test('the allowlist is load-bearing: without it the rules fire on both sanctioned sites', () => {
    // A guard that cannot fail is worse than no guard. With the allowlist disabled the
    // scan must name the provider adapter (its bare `fetch(`) and the npm child (its
    // `child_process` import) — so removing or narrowing any deciding pattern fails
    // here, and removing an allowlist entry fails the main guard above.
    const files = new Set(
      collectOffenders(false).map((offender) => offender.slice(0, offender.indexOf(':')))
    );
    assert.ok(files.has(PROVIDER_ADAPTER), 'the fetch rule no longer detects the provider adapter');
    assert.ok(files.has(NPM_CHILD), 'the child_process rule no longer detects the npm child');
  });

  test('the boundary test itself still detects a socket call', () => {
    // This feeds the real patterns a violating line would present, including the bare
    // `fetch(` form the module itself uses, which a naive `/[^.\w]fetch/` rule would
    // miss at line start.
    const samples = [
      'const res = await fetch(url, init);',
      '  return fetch(url, init);',
      "import http from 'node:http';",
      'http.request(endpoint, options);',
      'net.connect(80, "169.254.169.254")',
      'dns.lookup(host, cb)',
      "import http2 from 'node:http2';",
      'http2.connect("https://registry.npmjs.org")',
      "import dgram from 'node:dgram';",
      'dgram.createSocket("udp4")',
      'const ws = new WebSocket(url);',
      "import { request } from 'undici';",
      "import { spawnSync } from 'child_process';",
    ];
    const matched = samples.filter((line) => RULES.some((rule) => rule.pattern.test(line)));
    assert.strictEqual(matched.length, samples.length, `patterns missed: ${samples.filter((s) => !matched.includes(s)).join(' | ')}`);

    const benign = [
      'const effect = refetch;',
      'await this.attempt(request);',
      '// no network here',
      "import { PaleeConfig } from '../types';",
      // `RegExp.exec` is not a child process — which is why the child-process rule is
      // import-shaped instead of call-shaped.
      'const match = FULL_VERSION.exec(version);',
      // A prose mention of a primitive is not a use of it.
      '// undici backs the global fetch',
    ];
    for (const line of benign) {
      assert.ok(
        !RULES.some((rule) => rule.pattern.test(line)),
        `the pattern cries wolf on: ${line}`
      );
    }
  });
});
