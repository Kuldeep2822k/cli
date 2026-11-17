import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { spawnSync } from 'node:child_process';
import { parseDocument } from 'yaml';
import { CLI_SPAWN_TIMEOUT_MS } from './cli-spawn-env';

/**
 * The tip's typecheck cannot see mid-branch breakage: #565 P3-09 shipped four
 * consecutive commits importing `src/diagnostic-value` before the commit that
 * created the module — every tip-side gate stayed green while `tsc --noEmit`
 * failed at each of them, breaking agent.md's per-change verification loop and
 * bisect. These tests pin the gate that makes that class of history
 * unfalsifiable-to-miss: one typecheck per commit in the merge-base range.
 *
 * Everything below runs without git, tar, npm or the network: the script's
 * plumbing is injected, while the temp-dir lifecycle and cleanup it drives are
 * real. The end-to-end behavior (real git archive + tsc per commit) is the CI
 * job pinned at the bottom of this file, and `npm run verify:history`.
 */

interface Commit {
  readonly sha: string;
  readonly subject: string;
}

interface TypecheckOutcome {
  readonly ok: boolean;
  readonly output?: string;
}

interface MainDeps {
  readonly log?: (message: string) => void;
  readonly git?: (args: string[]) => string;
  readonly materialize?: (commit: Commit, workDir: string) => string;
  readonly typecheck?: (treeDir: string) => TypecheckOutcome;
  readonly repoNodeModules?: string;
}

interface VerifyHistoryModule {
  parseArgs(argv: string[]): { base: string; head: string; help: boolean };
  resolveCommits(
    git: (args: string[]) => string,
    options: { base: string; head: string }
  ): { mergeBase: string; commits: Commit[] };
  materializeCommit(
    git: (args: string[]) => string,
    commit: Commit,
    workDir: string,
    repoNodeModules: string
  ): string;
  formatFailureDetail(output: string): string;
  main(argv: string[], deps?: MainDeps): number;
}

const verifyHistory = createRequire(__filename)('../scripts/verify-history.js') as VerifyHistoryModule;

const MERGE_BASE = '5dd7d8f000000000000000000000000000000000';
const TS2307 =
  "src/cli/validate.ts(15,33): error TS2307: Cannot find module '../diagnostic-value' or its corresponding type declarations.";

// The exact failure shape P3-09 produced on audit-p3-remediation: the
// pillar-key rewire commit and the three after it rewired diagnostic-value
// imports to a path that only names a module from b391af1 onward. Oldest
// first, in the order a bisect walks.
const FAILING_COMMITS: ReadonlyArray<Commit> = [
  {
    sha: '0c4a17f000000000000000000000000000000000',
    subject: "P3-09: refactor: import the pillar-key list from the engine's PILLAR_KEYS in all five consumers. Refs #565."
  },
  { sha: '1eb3719000000000000000000000000000000000', subject: 'P3-10: refactor: define PALEE_OWNED_KEYS beside the scaffold builder' },
  { sha: '2fffe06000000000000000000000000000000000', subject: 'P3-11: refactor(storage): share one batch-scope predicate across adopt and adopt-undo' },
  { sha: '85ffff3000000000000000000000000000000000', subject: 'P3-13: fix(adopt): judge non-string palee_id one way via isValidPaleeId' }
];
const GREEN_COMMIT: Commit = { sha: 'b391af1000000000000000000000000000000000', subject: 'chore: post-gate adjustments for wave 2' };

interface FixtureCommit extends Commit {
  typechecks: boolean;
}

const ALL_COMMITS: ReadonlyArray<FixtureCommit> = [
  ...FAILING_COMMITS.map((commit) => ({ ...commit, typechecks: false })),
  { ...GREEN_COMMIT, typechecks: true }
];

function fakeGit(commits: ReadonlyArray<FixtureCommit>): (args: string[]) => string {
  return (args) => {
    if (args[0] === 'merge-base') {
      return `${MERGE_BASE}\n`;
    }
    return commits.map((commit) => `${commit.sha}\t${commit.subject}`).join('\n');
  };
}

function fakeDeps(commits: ReadonlyArray<FixtureCommit>) {
  const logs: string[] = [];
  const workDirs: string[] = [];
  const gitCalls: string[][] = [];
  const typecheckCalls: string[] = [];

  const materialize = (commit: Commit, workDir: string): string => {
    workDirs.push(workDir);
    const treeDir = path.join(workDir, 'tree');
    fs.mkdirSync(treeDir, { recursive: true });
    fs.writeFileSync(path.join(treeDir, 'commit-under-test'), commit.sha);
    return treeDir;
  };

  const typecheck = (treeDir: string): TypecheckOutcome => {
    typecheckCalls.push(treeDir);
    const sha = fs.readFileSync(path.join(treeDir, 'commit-under-test'), 'utf8');
    const commit = commits.find((candidate) => candidate.sha === sha);
    assert.ok(commit, `typecheck fake has no fixture commit for ${sha}`);
    return commit.typechecks ? { ok: true } : { ok: false, output: TS2307 };
  };

  const deps: MainDeps = {
    log: (message) => {
      logs.push(message);
    },
    git: (args) => {
      gitCalls.push(args);
      return fakeGit(commits)(args);
    },
    materialize,
    typecheck
  };
  return { deps, logs, workDirs, gitCalls, typecheckCalls, materialize };
}

describe('scripts/verify-history.js — per-commit typecheck gate (#565 P3-09)', () => {
  describe('argument parsing', () => {
    test('defaults to base main and head HEAD', () => {
      assert.deepStrictEqual(verifyHistory.parseArgs([]), { base: 'main', head: 'HEAD', help: false });
    });

    test('accepts --base, --head and --help', () => {
      assert.deepStrictEqual(verifyHistory.parseArgs(['--base', 'origin/main']), {
        base: 'origin/main',
        head: 'HEAD',
        help: false
      });
      assert.deepStrictEqual(verifyHistory.parseArgs(['--base', 'main', '--head', 'v1.1.0']), {
        base: 'main',
        head: 'v1.1.0',
        help: false
      });
      assert.deepStrictEqual(verifyHistory.parseArgs(['--help']), { base: 'main', head: 'HEAD', help: true });
    });

    test('a bare --base and an unknown flag both fail loudly', () => {
      assert.throws(() => verifyHistory.parseArgs(['--base']), /--base requires a ref argument/);
      assert.throws(() => verifyHistory.parseArgs(['--freeze']), /unknown argument: --freeze/);
    });
  });

  describe('commit range', () => {
    test('asks git for the merge base and lists commits oldest first', () => {
      const calls: string[][] = [];
      const { mergeBase, commits } = verifyHistory.resolveCommits(
        (args) => {
          calls.push(args);
          return fakeGit(ALL_COMMITS)(args);
        },
        { base: 'main', head: 'HEAD' }
      );
      assert.deepStrictEqual(calls, [
        ['merge-base', 'main', 'HEAD'],
        ['log', '--reverse', '--format=%H%x09%s', `${MERGE_BASE}..HEAD`]
      ]);
      assert.strictEqual(mergeBase, MERGE_BASE);
      assert.deepStrictEqual(
        commits.map((commit) => commit.sha),
        ALL_COMMITS.map((commit) => commit.sha)
      );
      assert.strictEqual(commits[0]?.subject, ALL_COMMITS[0]?.subject);
    });

    test('an empty range yields no commits (the exit-0 nothing-to-check path)', () => {
      const { commits } = verifyHistory.resolveCommits(
        (args) => (args[0] === 'merge-base' ? `${MERGE_BASE}\n` : ''),
        { base: 'main', head: 'HEAD' }
      );
      assert.deepStrictEqual(commits, []);
    });
  });

  describe('failure reporting', () => {
    test('caps the detail at ten lines, keeps the first error, and says how much was cut', () => {
      const noisy = [TS2307, ...Array.from({ length: 35 }, (_, index) => `noise line ${index}`)].join('\n');
      const detail = verifyHistory.formatFailureDetail(noisy);
      const lines = detail.split('\n');
      assert.strictEqual(lines.length, 11, 'ten shown lines plus the cut line');
      assert.match(lines[0] ?? '', /TS2307/);
      assert.match(lines[10] ?? '', /… 26 more line\(s\)/);
      for (const line of lines) {
        assert.ok(line.startsWith('    '), `detail lines are indented under the commit: ${line}`);
      }
    });
  });

  describe('main() over an injected history', () => {
    test('the P3-09 shape: four mid-branch commits fail, the gate exits 1 and names them in order', () => {
      const { deps, logs, workDirs } = fakeDeps(ALL_COMMITS);
      const exit = verifyHistory.main([], deps);
      assert.strictEqual(exit, 1);

      const named = logs
        .filter((line) => line.startsWith('  - '))
        .map((line) => line.replace(/^ {2}- /, '').split(' ')[0] ?? '');
      assert.deepStrictEqual(named, FAILING_COMMITS.map((commit) => commit.sha));

      const report = logs.join('\n');
      assert.ok(report.includes('4 of 5 commit(s) fail'), 'the summary counts failures');
      assert.ok(report.includes('TS2307'), 'each failing commit surfaces its first tsc error');
      assert.strictEqual(logs.filter((line) => line.startsWith('❌')).length, FAILING_COMMITS.length);
      assert.strictEqual(logs.filter((line) => line.startsWith('✅')).length, 1);

      for (const dir of workDirs) {
        assert.ok(!fs.existsSync(dir), `temp work dir survived the run: ${dir}`);
      }
    });

    test('an all-green history exits 0, typechecks every commit, and cleans up', () => {
      const green = ALL_COMMITS.map((commit) => ({ ...commit, typechecks: true }));
      const { deps, logs, workDirs, typecheckCalls } = fakeDeps(green);
      const exit = verifyHistory.main([], deps);
      assert.strictEqual(exit, 0);
      assert.strictEqual(typecheckCalls.length, ALL_COMMITS.length, 'one typecheck per commit');
      assert.ok(logs.some((line) => line.includes(`all ${ALL_COMMITS.length} commit(s) pass`)));
      for (const dir of workDirs) {
        assert.ok(!fs.existsSync(dir), `temp work dir survived the run: ${dir}`);
      }
    });

    test('a commit the gate cannot run against is reported failing, not skipped', () => {
      const { deps, logs, workDirs, materialize } = fakeDeps(ALL_COMMITS);
      const exit = verifyHistory.main([], {
        ...deps,
        materialize: (commit, workDir) => {
          if (commit.sha.startsWith('2fffe06')) {
            workDirs.push(workDir);
            throw new Error('git archive exited 128');
          }
          return materialize(commit, workDir);
        }
      });
      assert.strictEqual(exit, 1);
      const report = logs.join('\n');
      assert.ok(report.includes('check failed to run: git archive exited 128'));
      assert.ok(report.includes('2fffe06'), 'the uncheckable commit is named in the failure list');
      for (const dir of workDirs) {
        assert.ok(!fs.existsSync(dir), `temp work dir survived the failure: ${dir}`);
      }
    });

    test('a range with no commits exits 0 without materializing anything', () => {
      const logs: string[] = [];
      const exit = verifyHistory.main([], {
        log: (message) => {
          logs.push(message);
        },
        git: (args) => (args[0] === 'merge-base' ? `${MERGE_BASE}\n` : ''),
        materialize: (): string => {
          throw new Error('materialize must not run for an empty range');
        }
      });
      assert.strictEqual(exit, 0);
      assert.ok(logs.some((line) => line.includes('no commits between')));
    });

    test('--help exits 0 and never runs git', () => {
      const logs: string[] = [];
      const gitCalls: string[][] = [];
      const exit = verifyHistory.main(['--help'], {
        log: (message) => {
          logs.push(message);
        },
        git: (args) => {
          gitCalls.push(args);
          return '';
        }
      });
      assert.strictEqual(exit, 0);
      assert.deepStrictEqual(gitCalls, []);
      assert.ok(logs.join('\n').includes('--base'));
    });

    test('an unknown base ref exits 2 and names the git command that failed', () => {
      const logs: string[] = [];
      const exit = verifyHistory.main([], {
        log: (message) => {
          logs.push(message);
        },
        git: (args) => {
          if (args[0] === 'merge-base') {
            throw new Error('git merge-base nosuchref HEAD exited 1: fatal: not a valid ref');
          }
          return '';
        }
      });
      assert.strictEqual(exit, 2);
      assert.ok(logs.some((line) => line.includes('merge-base')));
    });

    test('a missing node_modules exits 2 with the remedy instead of typechecking nothing', () => {
      const { deps, logs } = fakeDeps(ALL_COMMITS);
      const absent = path.join(os.tmpdir(), 'palee-history-fixture-absent-node-modules');
      const exit = verifyHistory.main([], { ...deps, repoNodeModules: absent });
      assert.strictEqual(exit, 2);
      assert.ok(logs.some((line) => line.includes('run npm ci first')));
    });
  });
});

describe('materialization is platform-portable (GNU tar cannot see a drive letter)', () => {
  test('materializeCommit extracts the commit archive from a relative operand', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, timeout: CLI_SPAWN_TIMEOUT_MS });
    assert.strictEqual(head.status, 0, `git rev-parse failed: ${head.stderr}`);
    const commit = { sha: (head.stdout || '').trim(), subject: 'materialization probe' };
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-history-materialize-'));
    let treeDir: string | null = null;
    try {
      const git = (args: string[]): string => {
        const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true, timeout: CLI_SPAWN_TIMEOUT_MS });
        if (result.status !== 0) {
          throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
        }
        return result.stdout;
      };
      const materialized = verifyHistory.materializeCommit(git, commit, workDir, path.resolve(repoRoot, 'node_modules'));
      treeDir = materialized;
      assert.ok(fs.existsSync(path.join(materialized, 'package.json')), 'the commit tree must be extracted');
    } finally {
      if (treeDir !== null) {
        try { fs.rmSync(path.join(treeDir, 'node_modules'), { force: true }); } catch {}
      }
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('the per-commit gate is wired where pull requests run it', () => {
  interface WorkflowJob {
    'if'?: string;
    'timeout-minutes'?: number;
    needs?: string | string[];
    steps?: Array<{ run?: string; uses?: string; with?: Record<string, unknown> }>;
  }

  const workflowPath = path.resolve(__dirname, '../.github/workflows/ci.yml');
  const doc = parseDocument(fs.readFileSync(workflowPath, 'utf8')).toJSON() as {
    jobs: Record<string, WorkflowJob>;
  };

  test('package.json exposes the gate as npm run verify:history', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    assert.strictEqual(pkg.scripts?.['verify:history'], 'node scripts/verify-history.js');
  });

  test('a pull request typechecks its merge-base range, not just the tip', () => {
    const job = doc.jobs['commit-history-typecheck'];
    assert.ok(job, 'ci.yml must declare commit-history-typecheck');
    assert.strictEqual(job['if'], "github.event_name == 'pull_request'");
    assert.strictEqual(job['timeout-minutes'], 30, 'one typecheck per commit needs headroom');

    const checkout = (job.steps ?? []).find((step) => (step.uses ?? '').startsWith('actions/checkout'));
    assert.strictEqual(
      checkout?.with?.['fetch-depth'],
      0,
      'the merge-base range needs the full history, like the diff-cover leg'
    );

    const gate = (job.steps ?? []).find((step) => (step.run ?? '').includes('scripts/verify-history.js'));
    assert.ok(gate, 'the job must run the gate script');
    assert.match(gate.run ?? '', /--base origin\/main/);
  });

  test('the ci-success gate waits on the history job too', () => {
    const needs = doc.jobs['ci-success']?.needs ?? [];
    const required = Array.isArray(needs) ? needs : [needs];
    assert.ok(
      required.includes('commit-history-typecheck'),
      'a red mid-branch commit must fail CI, not just a job nobody reads'
    );
  });
});
