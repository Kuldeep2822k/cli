const fs = require('fs');

function editDashboard() {
    let content = fs.readFileSync('src/cli/dashboard.ts', 'utf8');
    content = content.replace(/for \(const filePath of files\) \{\n\s*const content = fs\.readFileSync\(filePath, \'utf8\'\);\n\s*const \{ frontmatter \} = parseFrontmatter\(content\);/g, 
        "const fileContents = await Promise.all(\n      files.map(async (filePath) => {\n        const content = await fs.promises.readFile(filePath, 'utf8');\n        return { filePath, content };\n      })\n    );\n    for (const { filePath, content } of fileContents) {\n      const { frontmatter } = parseFrontmatter(content);");
    // fix the null due_at logic in due queue
    content = content.replace(/const due = topics\.filter\(t => \!t\.due_at \|\| t\.due_at <= now\)\.length;/g, 
        "const due = topics.filter(t => t.due_at && t.due_at <= now).length;");
    content = content.replace(/const dueTopics = topics\.filter\(t => \!t\.due_at \|\| t\.due_at <= now\);/g, 
        "const dueTopics = topics.filter(t => t.due_at && t.due_at <= now);");
    content = content.replace(/if \(\!a\.due_at\) return -1;\n\s*if \(\!b\.due_at\) return 1;/g, "");
    fs.writeFileSync('src/cli/dashboard.ts', content, 'utf8');
}
editDashboard();

function editProgress() {
    let content = fs.readFileSync('src/cli/progress.ts', 'utf8');
    content = content.replace(/for \(const filePath of files\) \{\n\s*const content = fs\.readFileSync\(filePath, \'utf8\'\);\n\s*const \{ frontmatter \} = parseFrontmatter\(content\);/g, 
        "const fileContents = await Promise.all(\n      files.map(async (filePath) => {\n        const content = await fs.promises.readFile(filePath, 'utf8');\n        return { filePath, content };\n      })\n    );\n    for (const { filePath, content } of fileContents) {\n      const { frontmatter } = parseFrontmatter(content);");
    fs.writeFileSync('src/cli/progress.ts', content, 'utf8');
}
editProgress();

function editReview() {
    let content = fs.readFileSync('src/cli/review.ts', 'utf8');
    content = content.replace(/for \(const filePath of files\) \{\n\s*const content = fs\.readFileSync\(filePath, \'utf8\'\);\n\s*const \{ frontmatter \} = parseFrontmatter\(content\);/g, 
        "const fileContents = await Promise.all(\n      files.map(async (filePath) => {\n        const content = await fs.promises.readFile(filePath, 'utf8');\n        return { filePath, content };\n      })\n    );\n    for (const { filePath, content } of fileContents) {\n      const { frontmatter } = parseFrontmatter(content);");
    content = content.replace(/if \(\!a\.due_at\) return -1;\n\s*if \(\!b\.due_at\) return 1;/g, "");
    content = content.replace(/const updates = \{[\s\S]*?feynman: quality,\n\s*\};\n/g, 
        "const updates = {\n          topic_mastery: newMastery,\n          repetition: newRepetition,\n          lapses: newLapses,\n          difficulty,\n          due_at: newDue.toISOString(),\n        };\n");
    // add catch for ECONFLICT
    content = content.replace(/catch \(e: unknown\) \{\n\s*const err = e as Error;\n\s*console\.error/g, "catch (e: unknown) {\n    const err = e as Error;\n    if ((err as any).code === 'ECONFLICT') {\n      console.error(err.message);\n      process.exit(4);\n    }\n    console.error");
    fs.writeFileSync('src/cli/review.ts', content, 'utf8');
}
editReview();

function editRoadmap() {
    let content = fs.readFileSync('src/cli/roadmap.ts', 'utf8');
    // Fix ECONFLICT
    content = content.replace(/catch \(e: unknown\) \{\n\s*const err = e as Error;\n\s*console\.error/g, "catch (e: unknown) {\n    const err = e as Error;\n    if ((err as any).code === 'ECONFLICT') {\n      console.error(err.message);\n      process.exit(4);\n    }\n    console.error");
    fs.writeFileSync('src/cli/roadmap.ts', content, 'utf8');
}
editRoadmap();

function editAdoptCLI() {
    let content = fs.readFileSync('src/cli/adopt.ts', 'utf8');
    // Fix ECONFLICT
    content = content.replace(/catch \(e: unknown\) \{\n\s*const err = e as Error;\n\s*console\.error/g, "catch (e: unknown) {\n    const err = e as Error;\n    if ((err as any).code === 'ECONFLICT') {\n      console.error(err.message);\n      process.exit(4);\n    }\n    console.error");
    fs.writeFileSync('src/cli/adopt.ts', content, 'utf8');
}
editAdoptCLI();

function editSession() {
    let content = fs.readFileSync('src/cli/session.ts', 'utf8');
    // Fix session list sorting
    content = content.replace(/const files = fs\.readdirSync\(sessionsDir\)\n\s*\.filter\(f => f\.endsWith\(\'\.md\'\)\)\n\s*\.slice\(0, 10\);/g, 
        "const files = fs.readdirSync(sessionsDir)\n      .filter(f => f.endsWith('.md'))\n      .map(f => ({ name: f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))\n      .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))\n      .map(f => f.name)\n      .slice(0, 10);");
    fs.writeFileSync('src/cli/session.ts', content, 'utf8');
}
editSession();

function editValidate() {
    let content = fs.readFileSync('src/cli/validate.ts', 'utf8');
    // Fix duplicate map
    content = content.replace(/const existing = idMap\.get\(id\);\n\s*if \(existing\) \{\n\s*errors\.push\(\{ rule: \'duplicate_id\', topic: existing, message: Duplicate palee_id: \$\{id\} \(also in \$\{filePath\}\) \}\);\n\s*errors\.push\(\{ rule: \'duplicate_id\', topic: filePath, message: Duplicate palee_id: \$\{id\} \(also in \$\{existing\}\) \}\);\n\s*\}\n\s*idMap\.set\(id, filePath\);/g, 
        "const existing = idMap.get(id);\n        if (existing) {\n          const prevErr = errors.find(e => e.rule === 'duplicate_id' && e.message.includes(Duplicate palee_id: ));\n          if (prevErr) {\n            prevErr.message += , ;\n          } else {\n            errors.push({ rule: 'duplicate_id', topic: existing, message: Duplicate palee_id:  (in , ) });\n          }\n        } else {\n          idMap.set(id, filePath);\n        }");
    fs.writeFileSync('src/cli/validate.ts', content, 'utf8');
}
editValidate();

function editSm2() {
    let content = fs.readFileSync('src/engine/sm2.ts', 'utf8');
    content = content.replace(/next\.setDate\(next\.getDate\(\) \+ Math\.round\(interval\)\);/g, 
        "const days = Math.round(interval);\n  const year = next.getUTCFullYear();\n  const month = next.getUTCMonth();\n  const date = next.getUTCDate() + days;\n  return new Date(Date.UTC(year, month, date, 0, 0, 0, 0));");
    fs.writeFileSync('src/engine/sm2.ts', content, 'utf8');
}
editSm2();
