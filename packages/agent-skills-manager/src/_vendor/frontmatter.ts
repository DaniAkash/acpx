// Vendored from vercel-labs/skills@1.5.22 src/frontmatter.ts.
// See THIRD_PARTY_NOTICES.md for upstream attribution.
import { parse as parseYaml } from 'yaml'

/**
 * Minimal frontmatter parser. Only supports YAML (the `---` delimiter).
 * Does NOT support `---js` / `---javascript` to avoid eval()-based RCE
 * that exists in gray-matter's built-in JS engine.
 */
export function parseFrontmatter(raw: string): {
  data: Record<string, unknown>
  content: string
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { data: {}, content: raw }
  const data = (parseYaml(match[1] ?? '') as Record<string, unknown>) ?? {}
  return { data, content: match[2] ?? '' }
}
