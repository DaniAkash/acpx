/**
 * Functional public API. Each verb composes readState -> plan* ->
 * applyPlan against the same workspaceDir. Zero shared mutable state
 * between calls; the manifest is a value read at the boundary.
 *
 * bind(workspaceDir) is stateless sugar for consumers who always pass
 * the same workspaceDir: each method call still goes through the full
 * readState + plan + applyPlan pipeline.
 *
 * For dry-run / batch composition, import from './lowlevel' instead
 * and use the pure planner functions directly.
 */

import { applyPlan, readState } from './io/index.ts'
import {
  planAdd,
  planDisconnect,
  planLink,
  planRemove,
  planRescan,
  planUnlink,
} from './planner/planner.ts'
import type {
  DisconnectPlanSummary,
  LinkPlanSummary,
  RemovePlanSummary,
  RescanReport,
  UnlinkPlanSummary,
} from './planner/types.ts'
import type {
  AgentId,
  AgentScope,
  ManifestServerEntry,
  McpServerSpec,
} from './types.ts'

function nowIso(): string {
  return new Date().toISOString()
}

export interface AddServerResult {
  name: string
  created: boolean
}

export async function addServer(
  workspaceDir: string,
  input: { name: string; spec: McpServerSpec },
): Promise<AddServerResult> {
  const state = await readState(workspaceDir)
  const plan = planAdd(state, input, nowIso())
  await applyPlan(plan)
  return { name: input.name, created: plan.created }
}

export interface LinkInputAPI {
  serverName: string
  agent: AgentId
  scope?: AgentScope
  projectRoot?: string
  configPath?: string
  allowOverwrite?: boolean
}

export async function link(
  workspaceDir: string,
  input: LinkInputAPI,
): Promise<LinkPlanSummary> {
  const state = await readState(workspaceDir, [input.agent], {
    scope: input.scope,
    projectRoot: input.projectRoot,
    overrides: input.configPath
      ? { [input.agent]: input.configPath }
      : undefined,
  })
  const plan = planLink(state, input, nowIso())
  await applyPlan(plan)
  return {
    serverName: plan.serverName,
    agent: plan.agent,
    scope: plan.scope,
    created: plan.created,
    overwroteForeign: plan.overwroteForeign,
  }
}

export interface UnlinkInputAPI {
  serverName: string
  agent: AgentId
  scope?: AgentScope
  projectRoot?: string
  configPath?: string
}

export async function unlink(
  workspaceDir: string,
  input: UnlinkInputAPI,
): Promise<UnlinkPlanSummary> {
  const state = await readState(workspaceDir, [input.agent], {
    scope: input.scope,
    projectRoot: input.projectRoot,
    overrides: input.configPath
      ? { [input.agent]: input.configPath }
      : undefined,
  })
  const plan = planUnlink(state, input)
  await applyPlan(plan)
  return {
    serverName: plan.serverName,
    agent: plan.agent,
    scope: plan.scope,
    removed: plan.removed,
  }
}

export interface DisconnectInputAPI {
  serverName: string
  agent: AgentId
  scope?: AgentScope
  projectRoot?: string
  removeIfLast?: boolean
}

export async function disconnect(
  workspaceDir: string,
  input: DisconnectInputAPI,
): Promise<DisconnectPlanSummary> {
  // Look up the recorded configPath from the manifest so we read the
  // exact file link() wrote to. Without this, an override at link()
  // time gets lost and disconnect would rewrite the OS-resolved path
  // instead of the one that actually has the entry.
  const initial = await readState(workspaceDir)
  const linkRecord =
    initial.manifest.servers[input.serverName]?.links[input.agent]
  const state = await readState(workspaceDir, [input.agent], {
    scope: input.scope,
    projectRoot: input.projectRoot,
    overrides: linkRecord?.configPath
      ? { [input.agent]: linkRecord.configPath }
      : undefined,
  })
  const plan = planDisconnect(state, input)
  await applyPlan(plan)
  return {
    agent: plan.agent,
    serverName: plan.serverName,
    scope: plan.scope,
    unlinked: plan.unlinked,
    removedManifest: plan.removedManifest,
  }
}

export interface RemoveInputAPI {
  serverName: string
  unlinkFirst?: boolean
}

export async function remove(
  workspaceDir: string,
  input: RemoveInputAPI,
): Promise<RemovePlanSummary> {
  // Read every linked agent's config file at the exact path the
  // manifest records. Same rationale as disconnect(): the link record
  // is the source of truth for where we wrote, not the OS default.
  const manifestState = await readState(workspaceDir)
  const server = manifestState.manifest.servers[input.serverName]
  const linkedAgents = server
    ? (Object.keys(server.links) as AgentId[]).filter((a) => server.links[a])
    : []
  const overrides: Partial<Record<AgentId, string>> = {}
  if (server) {
    for (const agent of linkedAgents) {
      const cp = server.links[agent]?.configPath
      if (cp) overrides[agent] = cp
    }
  }
  const state = await readState(workspaceDir, linkedAgents, { overrides })
  const plan = planRemove(state, input)
  await applyPlan(plan)
  return {
    serverName: plan.serverName,
    unlinkedAgents: plan.unlinkedAgents,
    removedManifest: plan.removedManifest,
  }
}

export async function list(
  workspaceDir: string,
): Promise<ManifestServerEntry[]> {
  const state = await readState(workspaceDir)
  return Object.values(state.manifest.servers)
}

export interface ListedLink {
  serverName: string
  agent: AgentId
  configPath: string
}

export interface ListLinksInputAPI {
  serverNames?: string[]
  agents?: AgentId[]
}

export async function listLinks(
  workspaceDir: string,
  input?: ListLinksInputAPI,
): Promise<ListedLink[]> {
  const state = await readState(workspaceDir)
  const filterServers = input?.serverNames ? new Set(input.serverNames) : null
  const filterAgents = input?.agents ? new Set(input.agents) : null
  const out: ListedLink[] = []
  for (const server of Object.values(state.manifest.servers)) {
    if (filterServers && !filterServers.has(server.name)) continue
    for (const [agentRaw, link] of Object.entries(server.links)) {
      if (!link) continue
      const agent = agentRaw as AgentId
      if (filterAgents && !filterAgents.has(agent)) continue
      out.push({ serverName: server.name, agent, configPath: link.configPath })
    }
  }
  return out
}

export interface RescanInputAPI {
  agents?: AgentId[]
}

export async function rescan(
  workspaceDir: string,
  input?: RescanInputAPI,
): Promise<RescanReport> {
  const manifestState = await readState(workspaceDir)
  const filterAgents = input?.agents
  const referencedAgents = new Set<AgentId>()
  for (const server of Object.values(manifestState.manifest.servers)) {
    for (const agent of Object.keys(server.links)) {
      const id = agent as AgentId
      if (!filterAgents || filterAgents.includes(id)) referencedAgents.add(id)
    }
  }
  const state = await readState(workspaceDir, [...referencedAgents])
  const { rescan: report } = planRescan(state, input)
  return report
}

// -------------------------------------------------------------------
// bind: convenience wrapper for a fixed workspaceDir
// -------------------------------------------------------------------

export interface BoundApi {
  addServer(input: {
    name: string
    spec: McpServerSpec
  }): Promise<AddServerResult>
  link(input: LinkInputAPI): Promise<LinkPlanSummary>
  unlink(input: UnlinkInputAPI): Promise<UnlinkPlanSummary>
  disconnect(input: DisconnectInputAPI): Promise<DisconnectPlanSummary>
  remove(input: RemoveInputAPI): Promise<RemovePlanSummary>
  list(): Promise<ManifestServerEntry[]>
  listLinks(input?: ListLinksInputAPI): Promise<ListedLink[]>
  rescan(input?: RescanInputAPI): Promise<RescanReport>
}

export function bind(workspaceDir: string): BoundApi {
  return {
    addServer: (input) => addServer(workspaceDir, input),
    link: (input) => link(workspaceDir, input),
    unlink: (input) => unlink(workspaceDir, input),
    disconnect: (input) => disconnect(workspaceDir, input),
    remove: (input) => remove(workspaceDir, input),
    list: () => list(workspaceDir),
    listLinks: (input) => listLinks(workspaceDir, input),
    rescan: (input) => rescan(workspaceDir, input),
  }
}
