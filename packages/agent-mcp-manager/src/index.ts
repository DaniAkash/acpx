/**
 * agent-mcp-manager public API (v0.0.4).
 *
 * The v0.0.3 class API (`createMcpManager`, `McpManager`) has been
 * removed. Consumers migrate to the functional verbs exported here or
 * to the low-level plan/apply primitives at
 * `agent-mcp-manager/lowlevel` for dry-run control.
 *
 * See README.md's Migration section for a verb-by-verb translation
 * table.
 */

export {
  detectInstalledAgents,
  getCatalogEntry,
  isAgentSupported,
  listSupportedAgents,
  resolveAgentMcpConfigPath,
  resolveAgentSurface,
} from './agents.ts'
export type {
  BoundApi,
  DisconnectInputAPI,
  LinkInputAPI,
  ListedLink,
  ListLinksInputAPI,
  RemoveInputAPI,
  RescanInputAPI,
  UnlinkInputAPI,
} from './api.ts'
export {
  bind,
  disconnect,
  link,
  list,
  listLinks,
  remove,
  rescan,
  unlink,
} from './api.ts'

export {
  AgentNotSupportedError,
  ForeignEntryError,
  InvalidServerSpecError,
  McpManagerError,
  ServerNotFoundError,
  UnresolvedConfigPathError,
  UnsupportedTransportError,
} from './errors.ts'

export type {
  DisconnectPlanSummary,
  LinkPlanSummary,
  RemovePlanSummary,
  RescanReport,
  UnlinkPlanSummary,
} from './planner/types.ts'

export type {
  AgentId,
  AgentInfo,
  AgentScope,
  ManifestLinkEntry,
  ManifestServerEntry,
  McpHttpSpec,
  McpServer,
  McpServerSpec,
  McpSseSpec,
  McpStdioSpec,
  McpTransport,
  ServerManifest,
} from './types.ts'

export const VERSION = '0.0.4-rc.2'
