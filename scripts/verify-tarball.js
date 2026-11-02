// Asserts the packed tarball ships what it must and nothing it must not
// (#565 P1-06). `execFileSync` with an argv array keeps the manifest-derived
// filename out of any shell: it is passed to `tar` as one argument, so a name
// carrying metacharacters can never be parsed as a command.
const { execFileSync } = require('child_process');
const pkg = require('../package.json');
const { readReleaseManifest, tarballFilename } = require('./release-manifest');
const filename = tarballFilename(readReleaseManifest());
const tarList = execFileSync('tar', ['-tzf', filename], { encoding: 'utf8' }).split('\n');

const REQUIRED = [
  'package/' + pkg.main,
  'package/' + pkg.types,
  'package/' + pkg.bin.palee.replace(/^\.\//, ''),
  'package/package.json',
  'package/dist/package.json',
  'package/README.md',
  'package/LICENSE'
];
const FORBIDDEN = ['package/src/', 'package/test/', 'package/.github/', 'package/planning/', 'package/coverage/', 'package/assets/'];

for (const req of REQUIRED) {
  if (!tarList.some(f => f.startsWith(req))) {
    console.error('❌ Missing required tarball file:', req);
    process.exit(1);
  }
}

for (const forb of FORBIDDEN) {
  if (tarList.some(f => f.startsWith(forb))) {
    console.error('❌ Forbidden file detected in tarball:', forb);
    process.exit(1);
  }
}
console.log('✅ Dynamic tarball assertions passed cleanly.');
