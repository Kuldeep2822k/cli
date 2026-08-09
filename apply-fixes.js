const fs = require('fs');
const path = require('path');

function replaceFile(filePath, replacements) {
    const p = path.join(process.cwd(), filePath);
    if (!fs.existsSync(p)) { console.log('Missing ' + p); return; }
    let content = fs.readFileSync(p, 'utf8');
    for (const r of replacements) {
        content = content.replace(r.search, r.replace);
    }
    fs.writeFileSync(p, content, 'utf8');
}

replaceFile('package.json', [
    { search: /"chalk": "\^6\.0\.0"/g, replace: '"chalk": "^4.1.2"' },
    { search: /"typescript": "\^6\.0\.3"/g, replace: '"typescript": "^5.6.3"' }
]);

replaceFile('src/cli/adopt.ts', [
    { search: /options\.dependsOn\.split\(\',\’\)\.map\(s => s\.trim\(\)\)/g, replace: "options.dependsOn.split(',').map(s => s.trim()).filter(Boolean)" },
    { search: /options\.dependsOn\.split\(\',\’\)/g, replace: "options.dependsOn.split(',')" }
]);

replaceFile('src/engine/mastery.ts', [
    { search: /if \(\!previous \|\| \!previous\.assessed_at\) return false;/g, replace: "if (!previous || !previous.assessed_at || !current.assessed_at) return false;" }
]);

replaceFile('src/cli/next.ts', [
    { search: /if \(!a\.dueAt\) return -1;/g, replace: "if (!a.dueAt && !b.dueAt) return 0;\n    if (!a.dueAt) return -1;" }
]);

replaceFile('src/cli/plan.ts', [
    { search: /if \(!a\.due_at\) return -1;/g, replace: "if (!a.due_at && !b.due_at) return 0;\n    if (!a.due_at) return -1;" }
]);

replaceFile('src/storage/frontmatter.ts', [
    { search: /\^---\\r\?\\n\(\[\\s\\S\]\*\?\)\\r\?\\n---\\r\?\\n\(\[\\s\\S\]\*\)\$/g, replace: "^---\\\\r?\\\\n([\\\\s\\\\S]*?)\\\\r?\\\\n---\(?:\\\\r?\\\\n)?([\\\\s\\\\S]*)$" }
]);

replaceFile('src/storage/atomic-write.ts', [
    { search: /throw new Error\(\`OCC conflict: \$\{targetPath\} fingerprint mismatch\`\);/g, replace: "const err = new Error(`OCC conflict: ${targetPath} fingerprint mismatch`); (err as any).code = 'ECONFLICT'; throw err;" }
]);

replaceFile('src/storage/lock.ts', [
    { search: /throw new Error\(\`Lock conflict: \$\{targetPath\} is locked by PID \$\{active\?\.pid \|\| \'unknown\'\}\`\);/g, replace: "const err = new Error(`Lock conflict: ${targetPath} is locked by PID ${active?.pid || 'unknown'}`); (err as any).code = 'ECONFLICT'; throw err;" }
]);

console.log('Done with simple replacements');
