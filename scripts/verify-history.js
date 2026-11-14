// Asserts every commit on a branch passes the repo's primary quality gate —
// strict `tsc --noEmit` — so a red commit can never hide mid-branch and break
// the per-change verification loop or bisect (#565 P3-09: four commits in the
// remediation branch imported `src/diagnostic-value` before the module that
// path names existed; every tip-side gate stayed green, the history did not).
// That failing range is a known, deliberate state until its split lands. One
// of the four, P3-10, contributed its share as a hunk bundled into unrelated
// item work: valid-review-fields.ts switched './diagnostic-value' to
// '../../diagnostic-value'. Repairing it is therefore a split, not a revert —
// keep './diagnostic-value' in the P3-10 commit and move the specifier switch
// into the commit that creates src/diagnostic-value.ts (b391af1, the post-gate
// chore re-landing the P3-12 neutral-module move).
// Opt-in locally because it runs one full typecheck per commit; CI runs it per
// pull request over the merge-base range:
//
//     node scripts/verify-history.js [--base <ref>] [--head <ref>]
//
// Each commit is materialized read-only with `git archive` (this repo has no
// .gitattributes, so no export-ignore can hide files from the check) into a
// temp dir with the current node_modules linked in, then that commit's own
// declared `typecheck` script runs inside it. The repository itself is never
// written: no checkout, no worktree, no index changes. Dependencies are the
// tip's — a PR that changes the dependency manifests mid-branch is still
// checked against the current node_modules, so narrow --base past a manifest
// change if that ever matters.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: node scripts/verify-history.js [--base <ref>] [--head <ref>]';
const MAX_ERROR_LINES = 10;

function parseArgs(argv) {
  const options = { base: 'main', head: 'HEAD', help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--base' || arg === '--head') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} requires a ref argument\n${USAGE}`);
      }
      options[arg.slice(2)] = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return options;
}

// Read-only queries only; nothing here writes repository state, so the gate is
// safe to run from any checkout state, including mid-rebase.
function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) {
    throw new Error(`could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${detail}`);
  }
  return result.stdout;
}

// Oldest first, so the report reads in the order a bisect would walk.
function resolveCommits(git, { base, head }) {
  const mergeBase = git(['merge-base', base, head]).trim();
  const log = git(['log', '--reverse', '--format=%H%x09%s', `${mergeBase}..${head}`]);
  const commits = log
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const tab = line.indexOf('\t');
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
  return { mergeBase, commits };
}

// Extracts the commit's tree and links the current node_modules into it. The
// link is a Windows junction (no admin rights needed) or a POSIX symlink; it
// is removed with its work dir, never followed.
function materializeCommit(git, commit, workDir, repoNodeModules) {
  const archiveName = 'tree.tar';
  const tarball = path.join(workDir, archiveName);
  git(['archive', '--format=tar', '-o', tarball, commit.sha]);
  const treeDir = path.join(workDir, 'tree');
  fs.mkdirSync(treeDir, { recursive: true });
  // GNU tar reads a drive-letter prefix in an archive operand as a remote host
  // ("tar: Cannot connect to C:"), so extract by relative name from the work
  // directory. `-C tree` is relative for the same reason; no absolute Windows
  // path ever reaches tar as an operand.
  const extract = spawnSync('tar', ['-xf', archiveName, '-C', 'tree'], { cwd: workDir, encoding: 'utf8', windowsHide: true });
  if (extract.error) {
    throw new Error(`could not run tar: ${extract.error.message}`);
  }
  if (extract.status !== 0) {
    throw new Error(`tar -xf exited ${extract.status}: ${(extract.stderr || '').trim()}`);
  }
  fs.rmSync(tarball, { force: true });
  fs.symlinkSync(
    repoNodeModules,
    path.join(treeDir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  return treeDir;
}

// Runs the commit's own declared `typecheck` script — the gate exactly as that
// commit defines it. Relative paths inside the script (node_modules/typescript/
// bin/tsc) resolve through the linked node_modules.
function runTypecheck(treeDir) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(treeDir, 'package.json'), 'utf8'));
  if (!packageJson.scripts || !packageJson.scripts.typecheck) {
    return { ok: false, output: 'package.json declares no typecheck script' };
  }
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'typecheck', '--silent'],
    { cwd: treeDir, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024 }
  );
  if (result.error) {
    return { ok: false, output: `could not run npm: ${result.error.message}` };
  }
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return { ok: result.status === 0, output };
}

function formatFailureDetail(output) {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  const detail = lines.slice(0, MAX_ERROR_LINES).map((line) => `    ${line}`);
  if (lines.length > MAX_ERROR_LINES) {
    detail.push(`    … ${lines.length - MAX_ERROR_LINES} more line(s)`);
  }
  return detail.join('\n');
}

function runMain(argv, deps) {
  const log = deps.log || ((message) => console.log(message));
  const options = parseArgs(argv);
  if (options.help) {
    log(USAGE);
    log('typechecks every commit between the merge base and HEAD; exits 0 only when all pass');
    return 0;
  }
  const git = deps.git || ((args) => runGit(args, REPO_ROOT));
  const repoNodeModules = deps.repoNodeModules || path.join(REPO_ROOT, 'node_modules');
  const materialize =
    deps.materialize ||
    ((commit, workDir) => materializeCommit(git, commit, workDir, repoNodeModules));
  const typecheck = deps.typecheck || runTypecheck;

  if (!fs.existsSync(repoNodeModules)) {
    throw new Error(`no node_modules at ${repoNodeModules} — run npm ci first`);
  }

  const { mergeBase, commits } = resolveCommits(git, options);
  if (commits.length === 0) {
    log(`no commits between ${mergeBase} and ${options.head} — nothing to check`);
    return 0;
  }
  log(`checking ${commits.length} commit(s) in ${mergeBase}..${options.head} against the typecheck gate`);

  const results = [];
  for (const commit of commits) {
    const started = Date.now();
    let workDir;
    try {
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-history-'));
      const treeDir = materialize(commit, workDir);
      const outcome = typecheck(treeDir);
      results.push({
        commit,
        ok: outcome.ok === true,
        seconds: (Date.now() - started) / 1000,
        output: outcome.output || ''
      });
    } catch (error) {
      // A commit the gate cannot run against is not a green commit; report it
      // as failing so the branch is fixed rather than the check bypassed.
      results.push({
        commit,
        ok: false,
        seconds: (Date.now() - started) / 1000,
        output: `check failed to run: ${error.message}`
      });
    } finally {
      if (workDir) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    }
  }

  for (const result of results) {
    log(`${result.ok ? '✅' : '❌'} ${result.commit.sha.slice(0, 12)} ${result.commit.subject} (${result.seconds.toFixed(1)}s)`);
    if (!result.ok) {
      log(formatFailureDetail(result.output));
    }
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) {
    log(`all ${results.length} commit(s) pass the typecheck gate — the history bisects`);
    return 0;
  }
  log(`${failed.length} of ${results.length} commit(s) fail the typecheck gate:`);
  for (const result of failed) {
    log(`  - ${result.commit.sha} ${result.commit.subject}`);
  }
  log('reorder, split, or fix these commits so every commit typechecks (#565 P3-09)');
  return 1;
}

function main(argv, deps = {}) {
  try {
    return runMain(argv, deps);
  } catch (error) {
    (deps.log || console.error)(`error: ${error.message}`);
    return 2;
  }
}

module.exports = { parseArgs, resolveCommits, materializeCommit, runTypecheck, formatFailureDetail, main, USAGE };

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
