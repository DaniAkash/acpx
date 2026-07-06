/**
 * Hand-authored transport-capability declarations, one entry per client id.
 *
 * Docker's `pkg/client/config.yml` gives us the STDIO write shape for each
 * client (parent key, tag key, injects, etc.). It does NOT tell us which
 * transports each client's parser accepts. That's a separate research
 * question and must live as hand-authored data with a source citation
 * comment.
 *
 * Every entry MUST cite a URL to the client's first-party MCP docs or a
 * research note. The sync-catalog script fails if a catalog client has
 * no entry here or if an entry lacks a citation comment.
 */

import type { McpTransport } from '../../src/types.ts'

export interface TransportsEntry {
  system: ReadonlyArray<McpTransport>
  /** Set when the project scope diverges from system scope (currently only claude-code). */
  project?: ReadonlyArray<McpTransport>
}

export const SUPPORTED_TRANSPORTS: Record<string, TransportsEntry> = {
  // https://docs.anthropic.com/en/docs/agents-and-tools/mcp
  // Claude Desktop rejects non-stdio entries at parse time (see BrowserOS
  // report + v0.0.2 diagnosis).
  'claude-desktop': { system: ['stdio'] },

  // https://docs.claude.com/en/docs/claude-code/mcp
  // System scope accepts all three; project scope (.mcp.json) requires
  // type: 'stdio' tag and rejects non-stdio in practice.
  'claude-code': {
    system: ['stdio', 'sse', 'http'],
    project: ['stdio'],
  },

  // https://docs.cursor.com/context/model-context-protocol
  cursor: { system: ['stdio', 'sse', 'http'] },

  // https://code.visualstudio.com/docs/copilot/chat/mcp-servers
  vscode: { system: ['stdio', 'sse', 'http'] },

  // https://ai.google.dev/gemini-api/docs/mcp
  gemini: { system: ['stdio', 'sse', 'http'] },

  // https://zed.dev/docs/ai/mcp
  // Zed accepts all three via context_servers.
  zed: { system: ['stdio', 'sse', 'http'] },

  // https://developers.openai.com/codex/mcp
  // Codex TOML config: `[mcp_servers.<name>]` with either `command` (stdio)
  // or `url` (streamable HTTP). SSE not supported.
  codex: { system: ['stdio', 'http'] },

  // https://github.com/cline/cline
  // Cline's MCP config mirrors the standard mcpServers stdio JSON shape.
  // No documented http/sse acceptance.
  cline: { system: ['stdio'] },

  // https://docs.continue.dev/customization/mcp-tools
  // Continue.dev's YAML mcpServers array accepts a `type` field with values
  // stdio / streamable-http / sse.
  continue: { system: ['stdio', 'sse', 'http'] },

  // https://block.github.io/goose/docs/getting-started/using-extensions
  // Goose extensions API accepts stdio via cmd/args, and a separate
  // streamable-http type. SSE deprecated.
  goose: { system: ['stdio', 'http'] },

  // https://lmstudio.ai/docs/typescript/mcp
  // LM Studio accepts stdio + streamable-http via the mcpServers block.
  lmstudio: { system: ['stdio', 'http'] },

  // https://opencode.ai/docs/mcp
  // OpenCode's mcp block supports type: 'local' (stdio) or 'remote' (http/sse).
  opencode: { system: ['stdio', 'sse', 'http'] },

  // https://sema4.ai/docs/mcp
  // Sema4.ai Studio: stdio only via the mcp_servers JSON block.
  sema4: { system: ['stdio'] },

  // https://kiro.dev/docs/mcp
  // Kiro accepts stdio + streamable-http via the standard mcpServers shape.
  kiro: { system: ['stdio', 'http'] },

  // https://github.com/charmbracelet/crush
  // Crush's mcp block accepts stdio + http.
  crush: { system: ['stdio', 'http'] },
}
