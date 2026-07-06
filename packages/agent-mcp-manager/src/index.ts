// Functional public API (v0.0.4+). See ./api.ts. The class API (createMcpManager)
// is kept exported for one more commit; commit 9 deletes it.

export {
  detectInstalledAgents,
  getCatalogEntry,
  isAgentSupported,
  listSupportedAgents,
  resolveAgentMcpConfigPath,
  resolveAgentSurface,
} from './agents.ts'
export type {
  AddServerResult,
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
  addServer,
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
export type { McpManager } from './manager.ts'
export { createMcpManager } from './manager.ts'
export type {
  DisconnectPlanSummary,
  LinkPlanSummary,
  RemovePlanSummary,
  RescanReport,
  UnlinkPlanSummary,
} from './planner/types.ts'

export type {
  AddServerOptions,
  AgentId,
  AgentInfo,
  AgentScope,
  InstalledServer,
  LinkServerOptions,
  LinkServerResult,
  ListLinksOptions,
  ListServersOptions,
  ManifestLinkEntry,
  ManifestServerEntry,
  McpHttpSpec,
  McpManagerOptions,
  McpServerLink,
  McpServerSpec,
  McpSseSpec,
  McpStdioSpec,
  McpTransport,
  RemoveServerOptions,
  RescanOptions,
  RescanResult,
  ServerManifest,
  UnlinkServerOptions,
  UnlinkServerResult,
} from './types.ts'

export const VERSION = '0.0.0'
