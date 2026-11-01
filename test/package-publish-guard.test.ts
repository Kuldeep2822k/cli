import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { parseDocument } from 'yaml';

const requireScript = createRequire(__filename);
const root = path.resolve(__dirname, '..');

/**
 * #565 P1-06 — no manifest-derived value may be interpolated into a shell step.
 *
 * `release.yml` published the tarball as `npm publish ${{ needs…outputs.package-filename }}`,
 * and `ci.yml` installed and compared it the same way. A `version` or `name` in
 * `package.json` carrying shell metacharacters was therefore parsed by the shell before
 * `npm` started, on the runner holding `NPM_TOKEN` and `id-token: write`. The values now
 * travel through `env:` and are quoted at the point of use, and `scripts/release-manifest.js`
 * refuses a manifest that is not a release semver / npm package name before any output is
 * published.
 *
 * This suite replaced a single-line regex that matched the vulnerable `npm publish` call:
 * that assertion could only be satisfied by re-introducing the interpolation. What replaced
 * it is broader — every `run:` block in both workflows is scanned, not one line.
 */
describe('npm publish build guard (#336)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const releasePath = path.join(root, '.github/workflows/release.yml');
  const ciPath = path.join(root, '.github/workflows/ci.yml');
  const release = fs.readFileSync(releasePath, 'utf8');
  const packer = fs.readFileSync(path.join(root, 'scripts/pack-package.js'), 'utf8');

  type Step = { run?: string; env?: Record<string, string>; shell?: string };
  type Jobs = Record<string, { steps?: Step[] }>;

  const releaseJobs = (parseDocument(release).toJSON() as { jobs: Jobs }).jobs;
  const ciJobs = (parseDocument(fs.readFileSync(ciPath, 'utf8')).toJSON() as { jobs: Jobs }).jobs;

  test('publishing rebuilds from source instead of shipping a stale dist/', () => {
    assert.strictEqual(pkg.scripts.prepublishOnly, 'npm run build');
  });

  test('no prepack hook, because CI already builds before it packs', () => {
    assert.strictEqual(
      pkg.scripts.prepack,
      undefined,
      'a prepack hook would re-run the build inside verify-and-pack npm pack',
    );
    const pack = packer.indexOf('npm pack');
    assert.ok(pack > -1, 'verify-and-pack packs a tarball');

    // The tarball is packed by the shared helper, so build-then-pack is an
    // ordering claim about two entries in `verify-and-pack`'s step list. Read
    // from the file text, a `npm run build` in some other job would satisfy the
    // comparison even after this job stopped building; read as job steps, it
    // cannot. Existence is asserted before order because `findIndex` answers -1
    // for a missing step, and -1 is trivially less than the pack index.
    const steps = releaseJobs['verify-and-pack']?.steps ?? [];
    const packAt = steps.findIndex((step) => (step.run ?? '').includes('scripts/pack-package.js'));
    const buildAt = steps.findIndex((step) => (step.run ?? '').includes('npm run build'));
    assert.ok(packAt > -1, 'verify-and-pack invokes the pack helper');
    assert.ok(buildAt > -1, 'verify-and-pack builds from source');
    assert.ok(buildAt < packAt, 'and builds before packing it');
  });

  test('the release job publishes the verified artifact, not the working tree', () => {
    assert.match(release, /needs: \[verify-and-pack, test-platforms\]/);

    const publishStep = (releaseJobs['publish-npm']?.steps ?? []).find((step) =>
      (step.run ?? '').startsWith('npm publish'),
    );
    assert.ok(publishStep, 'the release job publishes the tarball');
    assert.strictEqual(
      publishStep.run,
      'npm publish "$PACKAGE_FILENAME" --access public --provenance',
      'the artifact name is a quoted variable, not an interpolated expression',
    );
    assert.strictEqual(
      publishStep.env?.PACKAGE_FILENAME,
      '${{ needs.verify-and-pack.outputs.package-filename }}',
      'and it is the filename the verify-and-pack job produced',
    );
    assert.ok(publishStep.env?.NODE_AUTH_TOKEN, 'the publish step still carries the registry token');
    assert.strictEqual(
      publishStep.env?.NODE_AUTH_TOKEN,
      '${{ secrets.NPM_TOKEN }}',
      'and it is the release token, not some other secret',
    );
  });

  test('no workflow interpolates a value into a shell step (#565 P1-06)', () => {
    // Every `run:` in both workflows, not one line: the class is "a value from
    // `needs.*`/`steps.*` reaching the shell through interpolation", and any instance
    // of it is a parse before the program starts. A secret interpolated the same way is
    // the same defect with a worse payload — it lands in the command line.
    const offenders: string[] = [];
    for (const [file, jobs] of [
      ['release.yml', releaseJobs],
      ['ci.yml', ciJobs],
    ] as const) {
      for (const [jobName, job] of Object.entries(jobs)) {
        for (const [index, step] of (job.steps ?? []).entries()) {
          if (/\$\{\{[^}]*\b(outputs|secrets)\./.test(step.run ?? '')) {
            offenders.push(`${file}: ${jobName} step ${index}`);
          }
        }
      }
    }
    assert.deepStrictEqual(offenders, [], 'pass the value through `env:` and quote it instead');
  });

  test('every env-passed output is actually used, in a shell that can read it (#565 P1-06)', () => {
    // The interpolation guard alone is not enough: deleting the variable from the
    // command, or referencing a POSIX `$NAME` in a step whose Windows runner defaults
    // to pwsh, both keep the interpolation out of the file while breaking the release.
    // That second shape shipped in `ci.yml`'s install step before this assertion.
    const offenders: string[] = [];
    for (const [file, jobs] of [
      ['release.yml', releaseJobs],
      ['ci.yml', ciJobs],
    ] as const) {
      for (const [jobName, job] of Object.entries(jobs)) {
        for (const [index, step] of (job.steps ?? []).entries()) {
          const run = step.run ?? '';
          for (const [key, value] of Object.entries(step.env ?? {})) {
            if (!/\$\{\{[^}]*\boutputs\./.test(value)) continue;
            const posixForm = new RegExp(`\\$${key}\\b|\\$\\{${key}\\}`).test(run);
            const pwshForm = run.includes(`$env:${key}`);
            if (!posixForm && !pwshForm) {
              offenders.push(`${file}: ${jobName} step ${index} passes ${key} and never uses it`);
            }
            if (posixForm && step.shell !== 'bash') {
              offenders.push(
                `${file}: ${jobName} step ${index} uses $${key} without \`shell: bash\` ` +
                  '(Windows runners default to pwsh, where that expands to nothing)',
              );
            }
          }
        }
      }
    }
    assert.deepStrictEqual(offenders, []);
  });
});

/**
 * The manifest rules the pipeline shares, asserted directly.
 *
 * These run against the module rather than through a workflow, because a release
 * cannot be exercised from a test: the point is that a hostile or malformed
 * manifest is refused *before* `npm pack` runs and before any `GITHUB_OUTPUT`
 * line is written, so no downstream job can ever see the value.
 */
describe('release manifest rules (#565 P1-06)', () => {
  const verifier = fs.readFileSync(path.join(root, 'scripts/verify-tarball.js'), 'utf8');
  const { assertNpmVersion, assertPackageName, tarballFilename, readReleaseManifest } =
    requireScript('../scripts/release-manifest') as {
      assertNpmVersion: (version: unknown) => string;
      assertPackageName: (name: unknown) => string;
      tarballFilename: (manifest: { name: string; version: string }) => string;
      readReleaseManifest: () => { name: string; version: string };
    };

  test('a shell metacharacter in the version is refused', () => {
    assert.throws(
      () => assertNpmVersion('1.0.0; rm -rf /'),
      /not a release semver/,
      'the value must never reach a shell, so it must not reach the outputs either',
    );
    assert.throws(() => assertNpmVersion('1.0.0.0'), /not a release semver/);
    assert.throws(() => assertNpmVersion('v1.0.0'), /not a release semver/);
    assert.throws(() => assertNpmVersion(100), /not a release semver/);
    // The `typeof` half of the guard needs an input whose string form *is* valid:
    // a plain number already fails the regex, so it cannot prove that check is live.
    assert.throws(() => assertNpmVersion(['1.0.0']), /not a release semver/);
  });

  test('a prerelease and a build suffix are still release semver', () => {
    assert.strictEqual(assertNpmVersion('1.1.0-rc.1'), '1.1.0-rc.1');
    assert.strictEqual(assertNpmVersion('1.1.0+build.5'), '1.1.0+build.5');
    assert.strictEqual(assertNpmVersion('1.1.0-rc.1+build.5'), '1.1.0-rc.1+build.5');
    assert.strictEqual(assertNpmVersion('1.0.0-0'), '1.0.0-0', 'a numeric prerelease of zero is valid');
    assert.strictEqual(assertNpmVersion('1.0.0-alpha'), '1.0.0-alpha');
  });

  // #565 P1-06 review: the first draft's fragment `[0-9A-Za-z.-]+` accepted these.
  test('a malformed prerelease or build suffix is refused', () => {
    for (const version of ['1.0.0-01', '1.0.0-rc..1', '1.0.0+build..5', '1.0.0-', '1.0.0+']) {
      assert.throws(
        () => assertNpmVersion(version),
        /not a release semver/,
        `${version} is not a release semver`,
      );
    }
  });

  test('a package name carrying shell syntax is refused', () => {
    assert.throws(() => assertPackageName('@a/b$(id)'), /not a valid npm package name/);
    assert.throws(() => assertPackageName('palee; echo owned'), /not a valid npm package name/);
    assert.throws(() => assertPackageName(['@kuldeep2822k/palee']), /not a valid npm package name/);
    assert.strictEqual(assertPackageName('@kuldeep2822k/palee'), '@kuldeep2822k/palee');
  });

  test('a package name npm reserves or rejects for length is refused', () => {
    assert.throws(() => assertPackageName('node_modules'), /reserved by npm/);
    assert.throws(() => assertPackageName('favicon.ico'), /reserved by npm/);
    assert.throws(() => assertPackageName('a'.repeat(215)), /longer than the 214 characters/);
    assert.strictEqual(assertPackageName('a'.repeat(214)), 'a'.repeat(214), 'the limit itself is allowed');
  });

  test('the filename is derived from the manifest, not from a second expression', () => {
    assert.strictEqual(
      tarballFilename({ name: '@kuldeep2822k/palee', version: '1.1.0' }),
      'kuldeep2822k-palee-1.1.0.tgz',
    );
    assert.strictEqual(tarballFilename({ name: 'palee', version: '0.0.1' }), 'palee-0.0.1.tgz');
  });

  test('the repository manifest passes its own rules', () => {
    const manifest = readReleaseManifest();
    assert.match(manifest.name, /^@kuldeep2822k\/palee$/);
    assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  });

  test('verify-tarball reaches tar through execFileSync, never a shell', () => {
    assert.match(verifier, /execFileSync\(/, 'the tar call must take an argv array');
    assert.doesNotMatch(verifier, /\bexecSync\b/, 'a shell would parse the filename');
    assert.doesNotMatch(
      verifier,
      /pkg\.name\.replace/,
      'the filename expression has one home, and it is not this file',
    );
  });
});
