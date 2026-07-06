// AgentId re-exports the 23-client union declared in the internal
// catalog. Kept as a name alias for API surface continuity: consumers
// import `AgentId` from the package root, the catalog's `ClientId`
// stays internal.
import type { ClientId } from './_catalog/types.ts'

export type AgentId = ClientId

export type AgentScope = 'system' | 'project'

export type McpTransport = 'stdio' | 'sse' | 'http'

export interface AgentInfo {
  id: AgentId
  displayName: string
  /** Absolute path of the config file we would write to (or null when unresolvable on this OS). */
  configPath: string | null
  /** True iff one of the agent's `installCheckPaths` resolves on disk. */
  installed: boolean
}

export interface McpStdioSpec {
  transport: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpSseSpec {
  transport: 'sse'
  url: string
  headers?: Record<string, string>
}

export interface McpHttpSpec {
  transport: 'http'
  url: string
  headers?: Record<string, string>
}

export type McpServerSpec = McpStdioSpec | McpSseSpec | McpHttpSpec

export interface McpManagerOptions {
  /**
   * Workspace directory — where the manifest lives. Defaults to
   * `~/.acpx/mcp`. Created on demand.
   */
  workspaceDir?: string
  /**
   * Override the resolved MCP config file path for one or more agents.
   * Useful for tests, non-standard installs, and `scope: 'project'`
   * with a non-default project root.
   */
  agentConfigPaths?: Partial<Record<AgentId, string>>
  /**
   * 'system' writes to the per-user config file (e.g. `~/.claude.json`).
   * 'project' writes to the per-project file (e.g. `<root>/.cursor/mcp.json`).
   * Default: 'system'.
   */
  scope?: AgentScope
  /**
   * Required when `scope === 'project'`. The directory under which
   * project-scoped config files are resolved. Pass an absolute path.
   */
  projectRoot?: string
}

export interface AddServerOptions {
  /**
   * Identifier used in the manifest and as the key inside each agent's
   * config object. Required. Must be non-empty after trim.
   */
  name: string
  spec: McpServerSpec
}

export interface LinkServerOptions {
  serverName: string
  /** Single agent. For fan-out across many, call link() per agent. */
  agent: AgentId
  /** Override the resolved config path for this agent only. */
  configPath?: string
  /**
   * Bypass the foreign-entry safety check. When the on-disk config
   * already contains an entry under `serverName` that the manifest
   * did not write, `link()` normally throws `ForeignEntryError` to
   * protect the user from clobbering an entry another tool put
   * there. Set this to `true` to take ownership instead: the on-disk
   * entry is rewritten with the manifest's spec and a fresh
   * `links[agent]` record is added. Default false.
   *
   * Does NOT bypass the transport-capability check. A claude-desktop
   * link with an http spec still throws `UnsupportedTransportError`
   * regardless of this flag.
   */
  allowOverwrite?: boolean
}

export interface LinkServerResult {
  serverName: string
  agent: AgentId
  configPath: string
  /** False if a correctly-shaped entry already existed (idempotent path). */
  created: boolean
}

export interface UnlinkServerOptions {
  serverName: string
  agent: AgentId
  configPath?: string
}

export interface UnlinkServerResult {
  serverName: string
  agent: AgentId
  configPath: string
  /**
   * True when the entry was present on disk and the manifest, and was
   * removed. False when there was nothing on disk to remove (no-op).
   * Note: when the entry exists on disk but isn't recorded in the
   * manifest, `unlink()` throws `ForeignEntryError` instead of
   * returning a result.
   */
  removed: boolean
}

export interface RemoveServerOptions {
  serverName: string
  /** Default true — also unlink from every agent that the manifest tracks. */
  unlinkFirst?: boolean
}

export interface ListServersOptions {
  /** Default false. Reserved for future on-disk scan support. */
  scanUnmanaged?: boolean
}

export interface ListLinksOptions {
  /** Filter to a subset of agents. Default: every agent in the manifest. */
  agents?: AgentId[]
  /** Filter to a subset of server names. Default: every server in the manifest. */
  serverNames?: string[]
  /**
   * Default false. When true, also scan each agent's config file for
   * entries not in the manifest and report them as `unmanaged: true`.
   */
  scanUnmanaged?: boolean
}

export interface InstalledServer {
  name: string
  spec: McpServerSpec
  addedAt: string
  /** Map of agent id to that agent's recorded link. */
  links: Partial<Record<AgentId, ManifestLinkEntry>>
}

export interface McpServerLink {
  serverName: string
  agent: AgentId
  configPath: string
  /** True when the on-disk entry differs from the manifest record. */
  drifted?: boolean
  /** True when the manifest recorded the link but the on-disk entry is gone. */
  broken?: boolean
  /** True when the on-disk entry exists but the manifest doesn't track it. */
  unmanaged?: boolean
}

export interface ServerManifest {
  version: 1
  servers: Record<string, ManifestServerEntry>
}

export interface ManifestServerEntry {
  name: string
  spec: McpServerSpec
  addedAt: string
  links: Partial<Record<AgentId, ManifestLinkEntry>>
}

export interface ManifestLinkEntry {
  configPath: string
  createdAt: string
}

export interface RescanOptions {
  /**
   * 'merge' (default): preserve existing manifest metadata for entries
   *   the scan rediscovers; report on-disk entries we don't track as unmanaged.
   * 'replace': discard the existing manifest and seed from disk only —
   *   destructive of addedAt / source metadata. Currently unsupported.
   */
  mode?: 'merge' | 'replace'
}

export interface RescanResult {
  /** Manifest entries verified against disk (link exists and matches). */
  verified: McpServerLink[]
  /** Manifest entries the scan found drifted on disk. */
  drifted: McpServerLink[]
  /** Manifest entries with no corresponding disk entry. */
  broken: McpServerLink[]
  /** Disk entries with no manifest record. */
  unmanaged: McpServerLink[]
}
