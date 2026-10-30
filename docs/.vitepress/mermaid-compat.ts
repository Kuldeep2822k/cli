// Mermaid 12 parses stricter than 11: semicolons inside sequence messages and
// unquoted parentheses in flowchart edge labels are now rejected. Normalise at
// render time so the diagram sources stay untouched.

const ENTITY_REWRITES: Array<[string, string, string]> = [
  ['&rarr;', '\uE000', '#8594;'],
  ['&gt;', '\uE001', '#62;'],
  ['&lt;', '\uE002', '#60;'],
  ['&amp;', '\uE003', '#38;']
]

function normalizeSequence(source: string) {
  let out = source
  for (const [entity, placeholder] of ENTITY_REWRITES) out = out.split(entity).join(placeholder)
  out = out.replace(/;/g, '#59;')
  for (const [, placeholder, replacement] of ENTITY_REWRITES) {
    out = out.split(placeholder).join(replacement)
  }
  return out
}

function normalizeFlowchart(source: string) {
  return source.replace(
    /(\|[ \t]*)([^"|\r\n][^"|\r\n]*?)([ \t]*\|)/g,
    (match, before, label, after) => {
      if (!/[()]/.test(label)) return match
      return `${before}"${label.trim()}"${after}`
    }
  )
}

export function normalizeMermaidSource(source: string) {
  const start = source.trimStart().slice(0, 20)
  if (start.startsWith('sequenceDiagram')) return normalizeSequence(source)
  if (start.startsWith('flowchart') || start.startsWith('graph')) return normalizeFlowchart(source)
  return source
}
