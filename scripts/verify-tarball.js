const { execSync } = require('child_process');
const pkg = require('../package.json');
const filename = pkg.name.replace('@', '').replace('/', '-') + '-' + pkg.version + '.tgz';
const tarList = execSync(`tar -tzf ${filename}`, { encoding: 'utf8' }).split('\n');

const REQUIRED = [
  'package/' + pkg.main,
  'package/' + pkg.types,
  'package/' + pkg.bin.palee.replace(/^\.\//, ''),
  'package/package.json',
  'package/dist/package.json',
  'package/README.md',
  'package/LICENSE'
];
const FORBIDDEN = ['package/src/', 'package/test/', 'package/.github/', 'package/planning/', 'package/coverage/'];

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
