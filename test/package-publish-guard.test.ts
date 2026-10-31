import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { parseDocument } from 'yaml';

/**
 * Publishing has two paths and only one of them was guarded. `release.yml`
 * builds, packs, verifies the tarball and publishes *that artifact*; a human
 * running `npm publish` from a stale checkout ships whatever `dist/` happens to
 * be on disk — which is how `--version` can crash on a missing
 * `dist/package.json` (#336).
 *
 * #336 asked for `prepack`. `prepublishOnly` is the cheaper equivalent, because
 * `npm pack` runs `prepack` regardless of `--ignore-scripts`, and
 * `verify-and-pack` already builds before it packs — so `prepack` would build
 * twice on every release for no additional safety.
 */
describe('npm publish build guard (#336)', () => {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const packer = fs.readFileSync(path.join(root, 'scripts/pack-package.js'), 'utf8');
  const releaseJobs = (parseDocument(release).toJSON() as {
    jobs: Record<string, { steps?: Array<{ run?: string }> }>;
  }).jobs;

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
    assert.match(
      release,
      /npm publish \$\{\{ needs\.verify-and-pack\.outputs\.package-filename \}\}/,
    );
  });
});
