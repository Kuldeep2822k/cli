import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * INV-29 says non-AI commands open no network sockets. That is only a rule while there is
 * one place that can break it, and a comment cannot enforce that — this can. It reads the
 * source tree the way `test/planning-invariant-ids.test.ts` and
 * `test/docs-command-matrix.test.ts` read theirs: no execution, no fixture, just the
 * structure the project has promised.
 */
const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

/**
 * Call forms that can open a socket or resolve a name. Written as character classes so
 * this file does not match itself and quietly exempt the code that is allowed to network.
 */
const NETWORK_PRIMITIVES: Array<[string, RegExp]> = [
  ['fetch()', /(^|[^.\w])fetch\s*\(/],
  ['http.request()', /\bhttps?\s*\.\s*request\s*\(/],
  ['http.get()', /\bhttps?\s*\.\s*get\s*\(/],
  ['a raw socket', /\bnet\s*\.\s*connect\s*\(/],
  ['a TLS socket', /\btls\s*\.\s*connect\s*\(/],
  ['a DNS lookup', /\bdns\s*\.\s*(lookup|resolve)/],
  ['an import of net/tls/dns/http/https', /from\s+['"](?:node:)?(?:net|tls|dns|http|https)['"]/],
];

const ALLOWED = 'src/ai/provider.ts';

describe('INV-29 network boundary (#24)', () => {
  const offenders: string[] = [];

  for (const file of sourceFiles(srcDir)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (rel === ALLOWED || rel === 'test/ai-network-boundary.test.ts') continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const [label, pattern] of NETWORK_PRIMITIVES) {
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        if (pattern.test(lines[index])) offenders.push(`${rel}:${index + 1} uses ${label}`);
      }
    }
  }

  test('no source file outside the provider adapter can reach the network', () => {
    assert.deepStrictEqual(
      offenders,
      [],
      'INV-29: PALEE is offline by construction. A second socket site would need its own ' +
        'timeout, redaction, cancel and exit-code handling, and would silently widen the ' +
        'attack surface the provider adapter exists to concentrate.'
    );
  });

  test('the provider adapter is not part of the published library surface', () => {
    // `src/index.ts` is what `import { ... } from '@kuldeep2822k/palee'` exposes. Keeping
    // `ai` out of it means nothing that consumes PALEE as a library inherits a code path
    // that talks to a provider.
    const barrel = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
    assert.ok(!/from\s+['"]\.\/ai['"]/.test(barrel), 'src/index.ts must not re-export the AI subsystem');
  });

  test('the AI subsystem depends on types only, not on the CLI layer', () => {
    // The command handlers call the provider; the provider must never call back into a
    // command, or the seam that makes it testable turns into a cycle.
    for (const file of sourceFiles(path.join(srcDir, 'ai'))) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!/from\s+['"][^'"]*cli\//.test(text), `${path.basename(file)} must not import from src/cli`);
    }
  });

  test('the boundary test itself still detects a socket call', () => {
    // A guard that cannot fail is worse than no guard: it advertises coverage. This feeds
    // the real patterns a violating line would present, including the bare `fetch(` form
    // the module itself uses, which a naive `/[^.\w]fetch/` rule would miss at line start.
    const samples = [
      'const res = await fetch(url, init);',
      '  return fetch(url, init);',
      "import http from 'node:http';",
      'http.request(endpoint, options);',
      'net.connect(80, "169.254.169.254")',
      'dns.lookup(host, cb)',
    ];
    const matched = samples.filter((line) => NETWORK_PRIMITIVES.some(([, pattern]) => pattern.test(line)));
    assert.strictEqual(matched.length, samples.length, `patterns missed: ${samples.filter((s) => !matched.includes(s)).join(' | ')}`);

    const benign = [
      'const effect = refetch;',
      'await this.attempt(request);',
      '// no network here',
      "import { PaleeConfig } from '../types';",
    ];
    for (const line of benign) {
      assert.ok(
        !NETWORK_PRIMITIVES.some(([, pattern]) => pattern.test(line)),
        `the pattern cries wolf on: ${line}`
      );
    }
  });
});
