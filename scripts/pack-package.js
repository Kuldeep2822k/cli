// Packs the release tarball and publishes the names every downstream job reads
// (#565 P1-06). Validation runs before the outputs are written, so `filename` and
// `version` are guaranteed release-safe for every consumer of `needs.*.outputs`.
const fs = require('fs');
const { execSync } = require('child_process');
const { readReleaseManifest, tarballFilename } = require('./release-manifest');

const manifest = readReleaseManifest();
const filename = tarballFilename(manifest);

execSync('npm pack', { stdio: 'inherit' });

const output = process.env.GITHUB_OUTPUT;
if (output) {
  fs.appendFileSync(output, `filename=${filename}\nversion=${manifest.version}\n`);
}
console.log('Created tarball:', filename);
