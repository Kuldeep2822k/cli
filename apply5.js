const fs = require('fs');

function editFrontmatter() {
    let content = fs.readFileSync('src/storage/frontmatter.ts', 'utf8');
    content = content.replace(/const frontmatter = doc\.toJSON\(\) as Record<string, unknown>;/g, 
        "if (doc.errors && doc.errors.length > 0) {\n        return { frontmatter: null, body, raw, error: doc.errors[0].message };\n      }\n      const frontmatter = doc.toJSON() as Record<string, unknown>;");
    content = content.replace(/export function updateFrontmatter\(content: string, updates: Record<string, unknown>\): string \{/g,
        "export function updateFrontmatter(content: string, updates: Record<string, unknown>): string {\n  const parsed = parseFrontmatter(content);\n  if (parsed.error) throw new Error(Malformed frontmatter: );");
    fs.writeFileSync('src/storage/frontmatter.ts', content, 'utf8');
}
editFrontmatter();
