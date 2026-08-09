const fs = require('fs');

function editAdopt() {
    let content = fs.readFileSync('src/cli/adopt.ts', 'utf8');
    content = content.replace(/options\.dependsOn\.split\(\',\’\)/g, "options.dependsOn.split(',')");
    content = content.replace(/options\.dependsOn\.split\(\',\'\)\.map\(s => s\.trim\(\)\)/g, "options.dependsOn.split(',').map(s => s.trim()).filter(Boolean)");
    fs.writeFileSync('src/cli/adopt.ts', content, 'utf8');
}
editAdopt();

function editCache() {
    let content = fs.readFileSync('src/storage/cache.ts', 'utf8');
    if (!content.includes('VERIFY_THROTTLE_MS')) {
        content = content.replace(/const UNSETTLED_HORIZON = 2000;/g, "const UNSETTLED_HORIZON = 2000;\nconst VERIFY_THROTTLE_MS = 50;");
        content = content.replace(/fingerprint,\n\s*data,\n\s*\}\);/g, "fingerprint,\n        data,\n        lastVerified: Date.now(),\n      });");
        content = content.replace(/if \(\(now - mtime\) < UNSETTLED_HORIZON\) \{/g, "if ((now - mtime) < UNSETTLED_HORIZON) {\n        if ((now - entry.lastVerified) < VERIFY_THROTTLE_MS) {\n          return entry.data;\n        }");
        content = content.replace(/entry\.mtime = mtime;\n\s*return entry\.data;/g, "entry.mtime = mtime;\n        entry.lastVerified = now;\n        return entry.data;");
        content = content.replace(/if \(entry\.mtime === mtime\) \{/g, "if (entry.mtime === mtime) {\n        entry.lastVerified = now;");
        fs.writeFileSync('src/storage/cache.ts', content, 'utf8');
    }
}
editCache();

function editDependency() {
    let content = fs.readFileSync('src/engine/dependency.ts', 'utf8');
    if (!content.includes('visited.add')) {
        content = content.replace(/function detectCycle\(startNode: string\): string\[\] \| null \{/g, "function detectCycle(startNode: string): string[] | null {\n  const visited = new Set<string>();");
        content = content.replace(/visiting\.add\(node\);/g, "if (visited.has(node)) return null;\n    visiting.add(node);");
        content = content.replace(/visiting\.delete\(node\);\n\s*path\.pop\(\);\n\s*return null;/g, "visiting.delete(node);\n    visited.add(node);\n    path.pop();\n    return null;");
        fs.writeFileSync('src/engine/dependency.ts', content, 'utf8');
    }
}
editDependency();
