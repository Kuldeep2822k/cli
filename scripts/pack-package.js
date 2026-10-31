const fs = require('fs');
const { execSync } = require('child_process');

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

execSync('npm pack', { stdio: 'inherit' });

const filename = packageJson.name.replace('@', '').replace('/', '-') + '-' + packageJson.version + '.tgz';
const output = process.env.GITHUB_OUTPUT;
if (output) {
  fs.appendFileSync(output, `filename=${filename}\nversion=${packageJson.version}\n`);
}
console.log('Created tarball:', filename);
