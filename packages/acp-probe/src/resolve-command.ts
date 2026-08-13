// Type-only import so fallow sees the acpx peer dep. The runtime
// resolver below uses dynamic import() so the dep stays optional.
import type * as AcpxRuntime from 'acpx/runtime'
import { AgentResolveError } from './errors.ts'

type AcpAgentRegistryLike = ReturnType<typeof AcpxRuntime.createAgentRegistry>

interface AcpxRuntimeModule {
  createAgentRegistry?: () => AcpAgentRegistryLike
}

/**
 * Resolve a built-in agent id (e.g. `'claude'`) into an argv array by
 * deferring to `acpx/runtime`'s agent registry. This is the only code
 * path that touches `acpx` — it's lazy-imported and the dep is marked
 * optional. If acpx isn't installed, throws `AgentResolveError` with a
 * typed cause and a pointer at the `{ command }` / `{ argv }` fallback.
 */
export async function resolveAgentCommandFromId(id: string): Promise<string[]> {
  let mod: AcpxRuntimeModule | null = null
  try {
    mod = (await import('acpx/runtime' as never)) as AcpxRuntimeModule
  } catch {
    throw new AgentResolveError(
      `Cannot resolve agent id "${id}" — install \`acpx\` to use the built-in ` +
        `agent registry, or pass { command } / { argv } directly to probeAgent().`,
      { cause: 'acpx_not_installed' },
    )
  }
  if (typeof mod?.createAgentRegistry !== 'function') {
    throw new AgentResolveError(
      `Installed \`acpx\` does not expose createAgentRegistry. ` +
        `Pass { command } / { argv } directly to probeAgent() instead.`,
      { cause: 'acpx_incompatible' },
    )
  }
  const registry = mod.createAgentRegistry()
  // acpx's resolve() is permissive: unknown ids round-trip the input
  // verbatim rather than throwing. We pre-check against list() so the
  // caller gets a real AgentResolveError instead of a downstream
  // spawn_failed.
  let known: readonly string[] = []
  try {
    known = registry.list()
  } catch {
    /* registry.list() should never throw; treat as empty if it does */
  }
  if (!known.includes(id)) {
    throw new AgentResolveError(
      `\`acpx\` does not recognise agent id "${id}". Known: ${known.join(', ')}.`,
      { cause: 'unknown_agent' },
    )
  }
  let raw: string | string[]
  try {
    raw = registry.resolve(id)
  } catch (err) {
    throw new AgentResolveError(
      `\`acpx\` failed to resolve agent id "${id}".`,
      { cause: 'unknown_agent', original: err },
    )
  }
  // acpx's resolve() may return structured argv (string[]) or a legacy
  // command string. Use structured argv verbatim; shell-split the string.
  return Array.isArray(raw) ? [...raw] : splitArgv(raw)
}

/**
 * Split a shell-style command string into argv pieces. Supports quoted
 * substrings (single and double) and backslash escapes. Not a full POSIX
 * parser — just enough for typical ACP agent spawn commands
 * (e.g. `npx -y @agentclientprotocol/claude-agent-acp@^0.31.0`).
 */
export function splitArgv(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (const ch of command) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}
