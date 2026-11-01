/**
 * Release manifest rules — the validation and filename derivation the release
 * pipeline shares.
 *
 * @remarks
 * #565 P1-06: `release.yml` and `ci.yml` interpolated values read from
 * `package.json` straight into `run:` blocks (`VERSION=${{ ... }}`,
 * `npm publish ${{ ... }}`), so a crafted `version` or `name` containing shell
 * metacharacters was parsed by the shell before npm started — on the runner
 * holding `NPM_TOKEN` and `id-token: write`. Passing the values through `env:`
 * and quoting them removes the shell parse; this module removes the values.
 *
 * It is side-effect free on require (no `npm pack`, no output writes) so the
 * guard suite can assert the rules without running a release, and it is the one
 * home for the tarball filename expression, which `pack-package.js` and
 * `verify-tarball.js` each spelled out separately.
 *
 * CommonJS on purpose: both consumers are plain `.js` scripts run by `node`.
 */

const fs = require('fs');
const path = require('path');

/** Semantic version, including `-prerelease` and `+build` spellings. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** npm package name, scoped or plain, as the registry accepts it. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * Refuses a version that is not a release semver.
 *
 * @param {unknown} version - The `version` read from the package manifest
 * @returns {string} The same value, once validated
 * @throws {Error} When the value is not a string or not semver
 */
function assertNpmVersion(version) {
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new Error(`package.json version is not a release semver: ${JSON.stringify(version)}`);
  }
  return version;
}

/**
 * Refuses a name the npm registry would not accept.
 *
 * @param {unknown} name - The `name` read from the package manifest
 * @returns {string} The same value, once validated
 * @throws {Error} When the value is not a string or not a valid npm package name
 */
function assertPackageName(name) {
  if (typeof name !== 'string' || !NPM_NAME.test(name)) {
    throw new Error(`package.json name is not a valid npm package name: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Reads and validates the manifest the release publishes.
 *
 * @returns {{ name: string, version: string }} The validated identity
 * @throws {Error} When the manifest cannot be read, parsed, or validated
 */
function readReleaseManifest() {
  const manifestPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return { name: assertPackageName(pkg.name), version: assertNpmVersion(pkg.version) };
}

/**
 * The tarball name `npm pack` produces for a validated manifest.
 *
 * @param {{ name: string, version: string }} manifest - A validated manifest
 * @returns {string} The `.tgz` filename, without any directory
 */
function tarballFilename({ name, version }) {
  return `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
}

module.exports = { assertNpmVersion, assertPackageName, readReleaseManifest, tarballFilename };
