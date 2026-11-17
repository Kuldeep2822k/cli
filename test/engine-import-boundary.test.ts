import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The engine layer's import boundary (P3-12 of audit issue #565).
 *
 * The engine (`src/engine/`) is the lowest of the six layers: storage,
 * application, validation, and the CLI all import it downward, so it must
 * import none of them back or the layering is a cycle. That rule was only
 * ever prose — `prereq-text.ts` even folds Unicode by hand "because the
 * engine layer stays free of storage" — and it was exactly once violated:
 * `sm2.ts` imported `formatDiagnosticValue` from
 * `src/validation/rules/diagnostic-value` while `valid-topic-mastery.ts`
 * imported the engine. P3-12 relocated the diagnostic-value rendering to the
 * neutral, layer-free module `src/diagnostic-value.ts` (beside the shared
 * contract in `types.ts`), and this test keeps the boundary closed from both
 * ends: the engine may import only the neutral modules, and the neutral
 * module may import only the *other* neutral modules — never the engine,
 * because `sm2.ts` imports the neutral module downward and a back-import
 * would recreate the very cycle P3-12 removed.
 *
 * Like `ai-network-boundary.test.ts`, this reads the shipped source tree —
 * no execution, no fixture, just the structure the project has promised.
 */

const root = path.resolve(__dirname, '..');

/**
 * Shared, layer-free modules at the top of `src/` that the engine (and every
 * layer above it) may import. The shared contract `types.ts` and the neutral
 * diagnostic renderer P3-12 relocated here.
 */
const NEUTRAL_MODULES: readonly string[] = ['src/types', 'src/diagnostic-value'];

/**
 * What the neutral diagnostic module itself may import: the *other* neutral
 * modules only. Deliberately NOT `src/engine/**` — `sm2.ts` imports this
 * module downward, so an engine import here is the engine↔neutral cycle
 * P3-12 exists to remove. Every other resolution (all five layers included)
 * is flagged.
 */
const OTHER_NEUTRAL_MODULES: readonly string[] = ['src/types'];

/** Layers the engine must never import — it sits below all of them. */
const FORBIDDEN_LAYERS: readonly string[] = [
  'src/storage',
  'src/validation',
  'src/application',
  'src/cli',
  'src/ai',
];

interface SourceFile {
  /** POSIX-style path relative to the repo root, e.g. `src/engine/sm2.ts`. */
  rel: string;
  text: string;
}

/** What a scanned file may resolve a relative import to, by repo-relative path. */
type AllowedResolution = (resolved: string) => boolean;

/** Engine files: intra-engine imports plus the neutral shared modules. */
const ENGINE_ALLOWED: AllowedResolution = (resolved): boolean =>
  resolved === 'src/engine' ||
  resolved.startsWith('src/engine/') ||
  NEUTRAL_MODULES.includes(resolved);

/** The neutral diagnostic module: the other neutral modules only — no engine exemption. */
const NEUTRAL_ALLOWED: AllowedResolution = (resolved): boolean =>
  OTHER_NEUTRAL_MODULES.includes(resolved);

function engineFiles(): SourceFile[] {
  const dir = path.join(root, 'src', 'engine');
  const found: SourceFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...engineFilesAt(full, `src/engine/${entry.name}`));
    } else if (entry.name.endsWith('.ts')) {
      found.push({ rel: 'src/engine/' + entry.name, text: fs.readFileSync(full, 'utf8') });
    }
  }
  return found;
}

function engineFilesAt(dir: string, relDir: string): SourceFile[] {
  const found: SourceFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...engineFilesAt(full, `${relDir}/${entry.name}`));
    } else if (entry.name.endsWith('.ts')) {
      found.push({ rel: `${relDir}/` + entry.name, text: fs.readFileSync(full, 'utf8') });
    }
  }
  return found;
}

/** Resolves a relative specifier from a source file to a repo-relative path. */
function resolvesTo(fromRel: string, specifier: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
}

/**
 * Relative import specifiers on one source line. `from '...'` is matched
 * anywhere in the line so multi-line import blocks (`} from '../types';`)
 * and `export ... from` re-exports are covered; bare side-effect
 * `import '...'` is covered too. Comment-looking lines are prose, not
 * imports, and are skipped so a doc mention cannot cry wolf.
 */
function relativeSpecifiers(line: string): string[] {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return [];
  const matches = [
    ...trimmed.matchAll(/from\s+['"](\.[^'"]*)['"]|import\s+['"](\.[^'"]*)['"]/g),
  ];
  return matches.map((m) => m[1] ?? m[2] ?? '');
}

/**
 * Every relative import in `files` that does not resolve into `allowed`,
 * where `label` names the boundary in the failure message.
 */
function collectViolations(
  files: SourceFile[],
  allowed: AllowedResolution,
  label: string
): string[] {
  const violations: string[] = [];
  for (const { rel, text } of files) {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      assert.ok(line !== undefined);
      for (const specifier of relativeSpecifiers(line)) {
        const resolved = resolvesTo(rel, specifier);
        if (allowed(resolved)) continue;
        violations.push(
          `${rel}:${index + 1} imports '${specifier}' (resolves to ${resolved}) outside ${label}`
        );
      }
    }
  }
  return violations;
}

describe('engine import boundary (P3-12, #565)', () => {
  test('no engine file imports outside the engine layer, the shared contract, and the neutral diagnostic module', () => {
    const violations = collectViolations(
      engineFiles(),
      ENGINE_ALLOWED,
      'the engine layer'
    );
    assert.deepStrictEqual(
      violations,
      [],
      'P3-12: the engine is the lowest layer — the layers it must stay free of are ' +
        `${FORBIDDEN_LAYERS.join(', ')} — because they all import it downward, so it must ` +
        'import none of them back. Shared rendering helpers belong in ' +
        `the neutral modules (${NEUTRAL_MODULES.join(', ')}), which every layer imports downward.`
    );
  });

  test('the neutral diagnostic-value module imports only the other neutral modules', () => {
    // The relocation only breaks the cycle if the new home stays neutral. The
    // allowlist here is the OTHER neutral modules only — critically, it grants
    // no `src/engine/**` exemption: `sm2.ts` imports this module downward, so
    // a `from './engine/...'` back-import would recreate the P3-12 cycle.
    const rel = 'src/diagnostic-value.ts';
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const violations = collectViolations(
      [{ rel, text }],
      NEUTRAL_ALLOWED,
      'the neutral diagnostic module (other neutral modules only)'
    );
    assert.deepStrictEqual(violations, [], 'the neutral diagnostic module must not import the engine or any layer');
  });

  test('formatDiagnosticValue lives in the neutral module and sm2.ts wires it from there', () => {
    // The positive half of the predicate: the engine obtains its diagnostic
    // rendering from the neutral module, not from a copy folded back inline
    // or a re-import of the old validation home.
    const neutral = fs.readFileSync(path.join(root, 'src', 'diagnostic-value.ts'), 'utf8');
    assert.ok(
      neutral.includes('export function formatDiagnosticValue'),
      'formatDiagnosticValue must be exported from the neutral src/diagnostic-value.ts'
    );
    const sm2 = fs.readFileSync(path.join(root, 'src', 'engine', 'sm2.ts'), 'utf8');
    assert.ok(
      !/from\s+['"][^'"]*validation\//.test(sm2),
      'src/engine/sm2.ts must not import from the validation layer'
    );
    assert.ok(
      sm2.includes("from '../diagnostic-value'"),
      'src/engine/sm2.ts must import formatDiagnosticValue from the neutral module'
    );
  });

  test('the guard still fires on the reverted P3-12 import', () => {
    // A guard that cannot fail is worse than no guard. Feed it the exact line
    // P3-12 removed — an engine file importing the diagnostic renderer from
    // the validation layer — and the scan must name the file and the layer.
    const reverted: SourceFile = {
      rel: 'src/engine/sm2.ts',
      text: "import { formatDiagnosticValue } from '../validation/rules/diagnostic-value';",
    };
    const violations = collectViolations([reverted], ENGINE_ALLOWED, 'the engine layer');
    assert.strictEqual(violations.length, 1, 'the reverted import must be flagged');
    assert.ok(violations[0] !== undefined);
    assert.ok(
      violations[0].includes('src/engine/sm2.ts') && violations[0].includes('src/validation'),
      `the violation must name the file and the layer, got: ${String(violations[0])}`
    );
  });

  test('the neutral-module guard still fires on an engine back-import', () => {
    // The same load-bearing check for the neutral side: sm2.ts imports the
    // neutral module downward, so `from './engine/mastery'` inside it would
    // restore the engine↔neutral cycle P3-12 removed. The allowlist must
    // flag that fixture rather than exempting `src/engine/**` the way the
    // engine scan legitimately does.
    const fixture: SourceFile = {
      rel: 'src/diagnostic-value.ts',
      text: "import { computeTopicMastery } from './engine/mastery';",
    };
    const violations = collectViolations([fixture], NEUTRAL_ALLOWED, 'the neutral diagnostic module');
    assert.strictEqual(violations.length, 1, 'the neutral→engine back-import must be flagged');
    assert.ok(violations[0] !== undefined);
    assert.ok(
      violations[0].includes('src/diagnostic-value.ts') && violations[0].includes('src/engine'),
      `the violation must name the file and the engine resolution, got: ${String(violations[0])}`
    );
  });

  test('the guard does not cry wolf on legal engine imports', () => {
    const legal: SourceFile[] = [
      { rel: 'src/engine/mastery.ts', text: "import { Review } from '../types';" },
      { rel: 'src/engine/sm2.ts', text: "import { formatDiagnosticValue } from '../diagnostic-value';" },
      { rel: 'src/engine/dependency.ts', text: "import { computeSccs } from './scc';" },
      { rel: 'src/engine/topic-id.ts', text: "import crypto from 'crypto';" },
      { rel: 'src/engine/auto-chain.ts', text: "import { spawnSync } from 'child_process';" },
      {
        rel: 'src/engine/toc-chain.ts',
        text: '// prose mentioning from \'./other\' inside a comment is not an import',
      },
    ];
    assert.deepStrictEqual(collectViolations(legal, ENGINE_ALLOWED, 'the engine layer'), []);
  });
});
