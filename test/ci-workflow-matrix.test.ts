import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { parseDocument } from 'yaml';

/**
 * The matrix is the thing that was wrong, and a workflow file has no other
 * test: #269 attributes the merges that left `main` red or unverified between
 * v0.5.2 and v0.6.0 to legs no pull request ran (macOS). These assertions are
 * the fitness function that keeps the two event types from diverging again.
 */
describe('CI workflow matrix parity (#269 release health)', () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/ci.yml');
  const doc = parseDocument(fs.readFileSync(workflowPath, 'utf8')).toJSON() as {
    on: { push?: { branches?: string[]; tags?: string[] }; pull_request?: { branches?: string[] } };
    jobs: Record<string, { strategy?: { matrix?: { include?: { os: string; 'node-version': string }[] } & { os?: string[] } } }>;
  };

  test('a pull request runs the same matrix a push to main runs', () => {
    const combos = (doc.jobs['test-matrix']?.strategy?.matrix?.include ?? [])
      .map((entry) => `${entry.os}@${entry['node-version']}`)
      .sort();

    // No event-conditional ternary survives: the matrix is one list, so the
    // phrase that used to split the two paths cannot reappear by editing one
    // branch of it and forgetting the other.
    const raw = fs.readFileSync(workflowPath, 'utf8');
    assert.doesNotMatch(
      raw,
      /matrix: >-\s*\$\{\{ fromJSON\(\s*github\.event_name/,
      'the test matrix must not be conditional on the event'
    );

    // The whole set, not membership plus a count: dropping windows 22.x while
    // adding a second ubuntu leg satisfies `includes` checks and a length
    // assertion, and would leave `main` running a different matrix than a PR.
    assert.deepStrictEqual(combos, [
      'macos-latest@22.x',
      'macos-latest@24.x',
      'ubuntu-latest@22.x',
      'ubuntu-latest@24.x',
      'ubuntu-latest@26.x',
      'windows-latest@22.x',
      'windows-latest@24.x',
    ]);
  });

  test('the installed package is smoke-tested on macOS in a pull request too', () => {
    // `npm install -g` has to be proven on the set of platforms it ships to, not
    // merely on a set that happens to contain macOS plus two others.
    assert.deepStrictEqual(doc.jobs['smoke-install']?.strategy?.matrix?.os ?? [], [
      'ubuntu-latest',
      'windows-latest',
      'macos-latest',
    ]);
  });

  test('both installed-package smoke jobs exercise a real command, not just flags', () => {
    // `--version` and `--help` prove the shim resolves; they exit before the
    // dispatcher loads config, reads a vault, or emits JSON through the
    // packaged dependency tree. The smoke script does all three, and it has to
    // run wherever the package was just installed — CI's pre-merge legs and the
    // post-publish gate — or the claim silently narrows back to two flags.
    const script = 'scripts/smoke-installed.js';
    const releasePath = path.resolve(__dirname, '../.github/workflows/release.yml');
    const release = parseDocument(fs.readFileSync(releasePath, 'utf8')).toJSON() as {
      jobs: Record<string, { steps?: Array<{ run?: string }> }>;
    };
    const ci = parseDocument(fs.readFileSync(workflowPath, 'utf8')).toJSON() as {
      jobs: Record<string, { steps?: Array<{ run?: string }> }>;
    };

    const stepIndex = (job: { steps?: Array<{ run?: string }> } | undefined, needle: string): number =>
      (job?.steps ?? []).findIndex((step) => (step.run ?? '').includes(needle));

    // Existence before order. `findIndex` answers -1 for a step that is not
    // there, and any real index beats -1, so comparing the two positions alone
    // let a deleted `palee --help` step satisfy the check — the exact drift this
    // suite exists to catch, in the one leg that runs too rarely to notice.
    for (const [label, job] of [
      ['ci.yml smoke-install', ci.jobs['smoke-install']],
      ['release.yml smoke-test', release.jobs['smoke-test']],
    ] as Array<[string, { steps?: Array<{ run?: string }> } | undefined]>) {
      const helpAt = stepIndex(job, 'palee --help');
      const smokeAt = stepIndex(job, script);
      assert.ok(helpAt !== -1, `${label} must run palee --help at all`);
      assert.ok(smokeAt !== -1, `${label} must run the installed-binary smoke script at all`);
      assert.ok(smokeAt > helpAt, `${label} must run the smoke script after palee --help`);
    }

    assert.ok(fs.existsSync(path.resolve(__dirname, '..', script)), 'the smoke script the workflows invoke must exist');
  });

  test('both smoke jobs run the script from a checked-out repository', () => {
    // `npm install -g` delivers only the published package; the script ships
    // with the repository, so a smoke job without a checkout dies with
    // "Cannot find module" on the one run that happens after a release (found
    // as the post-publish leg on #457). The ordering is asserted because that
    // leg runs too rarely to be trusted to catch a dropped or reordered step.
    const script = 'scripts/smoke-installed.js';
    type SmokeJob = { steps?: Array<{ run?: string; uses?: string }> };
    const release = parseDocument(
      fs.readFileSync(path.resolve(__dirname, '../.github/workflows/release.yml'), 'utf8'),
    ).toJSON() as { jobs: Record<string, SmokeJob> };
    const ci = parseDocument(fs.readFileSync(workflowPath, 'utf8')).toJSON() as {
      jobs: Record<string, SmokeJob>;
    };

    const stepIndex = (
      job: SmokeJob | undefined,
      match: (step: { run?: string; uses?: string }) => boolean,
    ): number => (job?.steps ?? []).findIndex(match);

    for (const [label, job] of [
      ['ci.yml smoke-install', ci.jobs['smoke-install']],
      ['release.yml smoke-test', release.jobs['smoke-test']],
    ] as Array<[string, SmokeJob | undefined]>) {
      const checkoutAt = stepIndex(job, (step) => (step.uses ?? '').startsWith('actions/checkout'));
      const smokeAt = stepIndex(job, (step) => (step.run ?? '').includes(script));
      assert.ok(checkoutAt !== -1, `${label} must include an actions/checkout step`);
      assert.ok(smokeAt > checkoutAt, `${label} must run the smoke script after the checkout`);
    }
  });

  test('a release tag triggers CI as well as publishing', () => {
    assert.deepStrictEqual(doc.on.push?.tags, ['v*.*.*']);
    assert.ok(doc.on.push?.branches?.includes('main'));
    assert.ok(doc.on.pull_request?.branches?.includes('main'));
  });

  test('a tag cannot publish before the platform matrix has passed', () => {
    // CI's own tag run is a separate workflow, and a workflow cannot depend on
    // another's result — so the publish gate has to live in `release.yml`, which
    // means the matrix is written in two files. That duplication is precisely the
    // drift this suite exists to catch, so it is asserted rather than trusted: a
    // release gated on a narrower set than CI runs would gate a smaller claim than
    // the one being made.
    const releasePath = path.resolve(__dirname, '../.github/workflows/release.yml');
    const release = parseDocument(fs.readFileSync(releasePath, 'utf8')).toJSON() as {
      jobs: Record<string, {
        needs?: string | string[];
        strategy?: { matrix?: { include?: unknown[] } };
      }>;
    };

    const ciMatrix = doc.jobs['test-matrix']?.strategy?.matrix?.include ?? [];
    const releaseMatrix = release.jobs['test-platforms']?.strategy?.matrix?.include ?? [];
    assert.ok(ciMatrix.length > 0, 'precondition: CI declares a matrix');
    assert.deepStrictEqual(releaseMatrix, ciMatrix);

    const needs = release.jobs['publish-npm']?.needs ?? [];
    const required = Array.isArray(needs) ? needs : [needs];
    assert.ok(required.includes('test-platforms'), 'publishing must wait for the matrix');
    assert.ok(required.includes('verify-and-pack'), 'and for the artifact it publishes');
  });

  test('coverage script bounds concurrency and tests the full suite', () => {
    const pkgPath = path.resolve(__dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const coverageScript = pkg.scripts?.['test:coverage'] ?? '';
    assert.ok(
      coverageScript.includes('--test-concurrency=4'),
      'coverage must bound worker fan-out to 4 (ADR-0029)'
    );
    assert.ok(
      coverageScript.includes('"test/**/*.test.ts"'),
      'coverage must measure the same glob plain npm test measures'
    );
  });

  test('plain npm test bounds worker fan-out with the same cap as coverage', () => {
    const pkgPath = path.resolve(__dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const testScript: string = pkg.scripts?.test ?? '';
    assert.ok(
      testScript.includes('--test-concurrency=4'),
      'an uncapped pool spawns one tsx worker per core and fails to commit memory on a 16-core dev box'
    );
    const bound = (script: string): string | undefined => script.match(/--test-concurrency=(\d+)/)?.[1];
    assert.strictEqual(
      bound(testScript),
      bound(pkg.scripts?.['test:coverage'] ?? ''),
      'both launch paths must carry the same bound, or the unbounded one becomes the default people hit'
    );
  });

  // ── Shortcut contracts (#504) ───────────────────────────────────────────────
  // Nothing read these selection lists before, so a family could be added to one
  // shortcut and forgotten in the other — or dropped from both — with every
  // suite still green. The contract is written down here rather than derived from
  // the declaration it checks: a list computed from the script itself passes when
  // the script loses an entry, which is the failure this block exists to catch.

  const shortcutPkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')
  ) as { scripts?: Record<string, string> };
  const shortcutScripts: Record<string, string> = shortcutPkg.scripts ?? {};
  /** Root-level suites by repo-relative path, enumerated without importing them. */
  const suiteFiles: string[] = fs
    .readdirSync(__dirname)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `test/${name}`);

  /**
   * The `node --test` path arguments one shortcut passes.
   *
   * @remarks
   * Quoted `.test.ts` arguments only: `--import tsx` and the concurrency cap are
   * options rather than selections, and an unquoted token would be a path this
   * suite cannot see.
   */
  function selection(script: string | undefined): string[] {
    return [...(script ?? '').matchAll(/"([^"]*\.test\.ts)"/g)].map((match) => match[1] ?? '');
  }

  /** The suites of {@link suiteFiles} that a selection actually runs. */
  function expandsTo(patterns: string[]): string[] {
    return suiteFiles.filter((file) => patterns.some((pattern) => path.matchesGlob(file, pattern)));
  }

  test('unit and fast both select the application, validation and AI families', () => {
    // The families are named by the prefixes the tree actually carries — the
    // issue's proposed names did not exist, and a pattern that matches nothing
    // would satisfy a presence check on the string alone.
    for (const family of ['test/ai-*.test.ts', 'test/application-*.test.ts', 'test/validation-*.test.ts']) {
      const members = expandsTo([family]);
      assert.ok(members.length > 0, `precondition: ${family} matches a suite on disk`);
      for (const name of ['test:unit', 'test:fast']) {
        const selected = expandsTo(selection(shortcutScripts[name]));
        const missing = members.filter((file) => !selected.includes(file));
        assert.deepStrictEqual(missing, [], `${name} must select every ${family} suite`);
      }
    }
  });

  test('neither shortcut dropped a suite it already ran', () => {
    // Named explicitly, so the expansion of a wider family cannot vouch for an
    // entry a later edit deleted.
    const required: Record<string, string[]> = {
      'test:unit': [
        'test/engine-dependency.test.ts',
        'test/smoke.test.ts',
        'test/storage-lock.test.ts',
        'test/types-difficulty.test.ts',
      ],
      'test:fast': [
        'test/cli-adopt-batch.test.ts',
        'test/cli-commands.test.ts',
        'test/engine-sm2.test.ts',
        'test/fault-injection.test.ts',
        'test/property-fuzz.test.ts',
        'test/session-cli.test.ts',
        'test/smoke.test.ts',
        'test/storage-lock.test.ts',
        'test/stress-concurrency.test.ts',
        'test/timezone-matrix.test.ts',
        'test/types-difficulty.test.ts',
      ],
    };
    for (const [name, suites] of Object.entries(required)) {
      const selected = expandsTo(selection(shortcutScripts[name]));
      const missing = suites.filter((file) => !selected.includes(file));
      assert.deepStrictEqual(missing, [], `${name} must still run these suites`);
    }
  });

  test('fast stays the curated selection, not the whole tree', () => {
    // `test:fast` is the pre-push set: the challenger runs are long by design and
    // stay out. Redefining the shortcut as every root suite would change what its
    // name means while the name stayed the same.
    const challengers = expandsTo(['test/challenger1-*.test.ts']);
    assert.ok(challengers.length > 0, 'precondition: challenger suites exist');
    const patterns = selection(shortcutScripts['test:fast']);
    const adopted = challengers.filter((file) => expandsTo(patterns).includes(file));
    assert.deepStrictEqual(adopted, [], 'test:fast must not adopt the challenger suites');
    assert.ok(
      !patterns.includes('test/**/*.test.ts'),
      'test:fast is a curated list; the recursive glob belongs to npm test and coverage'
    );
  });

  test('unit stays build-free', () => {
    // `test:unit` imports the sources directly, so it has no build hook and
    // nothing it selects may launch the built CLI — a suite that spawns needs
    // `dist`, which this shortcut never produces.
    assert.strictEqual(shortcutScripts['pretest:unit'], undefined, 'test:unit must not gain a build hook');
    const launchers = expandsTo(selection(shortcutScripts['test:unit'])).filter((file) =>
      /from '\.\/(?:palee-cli|e2e\/test-env)'/.test(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'))
    );
    assert.deepStrictEqual(launchers, [], 'a CLI-spawning suite needs dist, which test:unit never builds');
  });

  test('every shortcut that launches the built CLI builds first', () => {
    for (const name of ['test', 'test:fast', 'test:e2e', 'test:fuzz', 'test:coverage']) {
      assert.strictEqual(
        shortcutScripts[`pre${name}`],
        'npm run build',
        `${name} spawns the built CLI, so it must keep its build hook`
      );
    }
  });

  test('npm test and test:coverage still select the same recursive suite', () => {
    const full = selection(shortcutScripts['test']);
    assert.deepStrictEqual(full, ['test/**/*.test.ts'], 'npm test keeps the one recursive selection');
    assert.deepStrictEqual(
      selection(shortcutScripts['test:coverage']),
      full,
      'coverage must measure exactly what npm test runs'
    );
    const unselected = suiteFiles.filter((file) => !expandsTo(full).includes(file));
    assert.deepStrictEqual(unselected, [], 'the recursive glob must reach every root suite');
  });
});
