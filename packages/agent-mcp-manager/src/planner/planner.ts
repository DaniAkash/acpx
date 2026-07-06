/**
 * Pure planner functions. Zero I/O; every input is a value read at
 * the boundary and every output is a Plan value the caller can inspect
 * before applying.
 *
 * These functions do NOT throw for "user made a mistake" cases (empty
 * server name, transport not supported by the client, foreign entry
 * on disk); they throw only for invariant violations that indicate a
 * caller bug. Domain errors surface as thrown errors from the API
 * layer, which composes readState -> plan* -> applyPlan and enriches
 * exceptions with paths from state.
 */

import { getCatalogEntry } from '../agents.ts'
import { getEmitter } from '../emitters/index.ts'
import {
  AgentNotSupportedError,
  ForeignEntryError,
  InvalidServerSpecError,
  ServerNotFoundError,
  UnsupportedTransportError,
} from '../errors.ts'
import type {
  AgentId,
  AgentScope,
  ManifestServerEntry,
  McpServerSpec,
  ServerManifest,
} from '../types.ts'
import type {
  AddServerInput,
  AgentFileState,
  DisconnectInput,
  DisconnectPlanSummary,
  FsOp,
  LinkInput,
  LinkPlanSummary,
  Plan,
  RemoveInput,
  RemovePlanSummary,
  RescanInput,
  RescanReport,
  State,
  UnlinkInput,
  UnlinkPlanSummary,
} from './types.ts'

// -------------------------------------------------------------------
// planAdd: add a server to the manifest with no agent link
// -------------------------------------------------------------------

export function planAdd(
  state: State,
  input: AddServerInput,
  now: string,
): Plan & { created: boolean } {
  if (!input.name.trim()) {
    throw new InvalidServerSpecError('server name is required')
  }
  validateSpec(input.spec)
  const existing = state.manifest.servers[input.name]
  const nextEntry: ManifestServerEntry = {
    name: input.name,
    spec: input.spec,
    addedAt: existing?.addedAt ?? now,
    links: existing?.links ?? {},
  }
  const nextManifest = putServer(state.manifest, nextEntry)
  return {
    ops: [manifestWriteOp(state, nextManifest)],
    nextManifest,
    created: !existing,
  }
}

// -------------------------------------------------------------------
// planLink
// -------------------------------------------------------------------

export function planLink(
  state: State,
  input: LinkInput,
  now: string,
): Plan & LinkPlanSummary {
  const scope = input.scope ?? 'system'
  const server = requireServer(state, input.serverName)
  ensureTransportSupported(input.agent, scope, server.spec.transport)
  const agentFile = requireAgentFile(state, input.agent, scope)
  const client = getCatalogEntry(input.agent)
  const emitter = getEmitter(client, scope)

  const existingKeys = emitter.read(agentFile.rawContent)
  const isKnownToManifest = Boolean(server.links[input.agent])
  const isForeign =
    existingKeys.includes(input.serverName) && !isKnownToManifest
  if (isForeign && !input.allowOverwrite) {
    throw new ForeignEntryError(
      input.serverName,
      input.agent,
      agentFile.configPath,
    )
  }

  const nextRaw = emitter.add(
    agentFile.rawContent,
    input.serverName,
    server.spec,
  )
  const nextManifest = putServer(state.manifest, {
    ...server,
    links: {
      ...server.links,
      [input.agent]: {
        configPath: agentFile.configPath,
        createdAt: server.links[input.agent]?.createdAt ?? now,
      },
    },
  })

  return {
    ops: [
      writeOp(agentFile.configPath, nextRaw),
      manifestWriteOp(state, nextManifest),
    ],
    nextManifest,
    serverName: input.serverName,
    agent: input.agent,
    scope,
    created: !isKnownToManifest,
    overwroteForeign: isForeign,
  }
}

// -------------------------------------------------------------------
// planUnlink
// -------------------------------------------------------------------

export function planUnlink(
  state: State,
  input: UnlinkInput,
): Plan & UnlinkPlanSummary {
  const scope = input.scope ?? 'system'
  const server = state.manifest.servers[input.serverName]
  if (!server) {
    return {
      ops: [],
      nextManifest: state.manifest,
      serverName: input.serverName,
      agent: input.agent,
      scope,
      removed: false,
    }
  }
  const linkRecord = server.links[input.agent]
  if (!linkRecord) {
    return {
      ops: [],
      nextManifest: state.manifest,
      serverName: input.serverName,
      agent: input.agent,
      scope,
      removed: false,
    }
  }
  const agentFile = findAgentFile(
    state,
    input.agent,
    scope,
    linkRecord.configPath,
  )
  const client = getCatalogEntry(input.agent)
  const emitter = getEmitter(client, scope)
  const ops: FsOp[] = []
  if (agentFile) {
    const nextRaw = emitter.remove(agentFile.rawContent, input.serverName)
    if (nextRaw !== agentFile.rawContent) {
      ops.push(writeOp(agentFile.configPath, nextRaw))
    }
  }

  const nextLinks = { ...server.links }
  delete nextLinks[input.agent]
  const nextManifest = putServer(state.manifest, {
    ...server,
    links: nextLinks,
  })
  ops.push(manifestWriteOp(state, nextManifest))

  return {
    ops,
    nextManifest,
    serverName: input.serverName,
    agent: input.agent,
    scope,
    removed: true,
  }
}

// -------------------------------------------------------------------
// planDisconnect: unlink + optionally drop the manifest entry when
// the disconnected agent was the last one linked.
//
// This is the primitive that closes issue #63. Under the class API,
// callers had to interleave listLinks + conditional remove. Any race
// or logic bug in the caller could orphan other agents' links. Under
// this planner, dropping the manifest entry is a single computation
// based on the post-unlink links map. Never touches other agents.
// -------------------------------------------------------------------

export function planDisconnect(
  state: State,
  input: DisconnectInput,
): Plan & DisconnectPlanSummary {
  const scope = input.scope ?? 'system'
  const removeIfLast = input.removeIfLast ?? true
  const server = state.manifest.servers[input.serverName]
  if (!server?.links[input.agent]) {
    return {
      ops: [],
      nextManifest: state.manifest,
      agent: input.agent,
      serverName: input.serverName,
      scope,
      unlinked: false,
      removedManifest: false,
    }
  }
  const unlinkPlan = planUnlink(state, {
    serverName: input.serverName,
    agent: input.agent,
    scope,
  })
  const remainingLinks =
    unlinkPlan.nextManifest.servers[input.serverName]?.links ?? {}
  const anyLinkLeft = Object.keys(remainingLinks).length > 0
  if (!removeIfLast || anyLinkLeft) {
    return {
      ...unlinkPlan,
      agent: input.agent,
      serverName: input.serverName,
      scope,
      unlinked: true,
      removedManifest: false,
    }
  }
  // Drop the manifest entry. Config files of other agents are NOT
  // touched: `remainingLinks` was empty, so no ops beyond the unlink's
  // agent-file rewrite and the manifest write are added.
  const nextManifest = removeServer(unlinkPlan.nextManifest, input.serverName)
  const opsWithoutManifestWrite = unlinkPlan.ops.filter((op) =>
    op.kind === 'writeFile' ? op.path !== state.manifestPath : true,
  )
  return {
    ops: [...opsWithoutManifestWrite, manifestWriteOp(state, nextManifest)],
    nextManifest,
    agent: input.agent,
    serverName: input.serverName,
    scope,
    unlinked: true,
    removedManifest: true,
  }
}

// -------------------------------------------------------------------
// planRemove: drop the manifest entry, optionally unlinking every
// currently-linked agent first.
// -------------------------------------------------------------------

export function planRemove(
  state: State,
  input: RemoveInput,
): Plan & RemovePlanSummary {
  const unlinkFirst = input.unlinkFirst ?? true
  const server = state.manifest.servers[input.serverName]
  if (!server) {
    return {
      ops: [],
      nextManifest: state.manifest,
      serverName: input.serverName,
      unlinkedAgents: [],
      removedManifest: false,
    }
  }
  const ops: FsOp[] = []
  const unlinkedAgents: AgentId[] = []
  let cursor = state.manifest
  if (unlinkFirst) {
    for (const [agent, link] of Object.entries(server.links)) {
      if (!link) continue
      // Every disk file we touch has a corresponding AgentFileState we
      // can find by configPath. If the caller didn't include this agent
      // in readState, we skip the file write (the manifest still gets
      // its unlink record dropped).
      const scope: AgentScope =
        link.configPath === deriveProjectPath(link.configPath)
          ? 'project'
          : 'system'
      const agentFile = findAgentFile(
        { ...state, manifest: cursor },
        agent as AgentId,
        scope,
        link.configPath,
      )
      if (agentFile) {
        const client = getCatalogEntry(agent as AgentId)
        const emitter = getEmitter(client, scope)
        const nextRaw = emitter.remove(agentFile.rawContent, input.serverName)
        if (nextRaw !== agentFile.rawContent) {
          ops.push(writeOp(agentFile.configPath, nextRaw))
        }
      }
      unlinkedAgents.push(agent as AgentId)
      cursor = putServer(cursor, {
        ...(cursor.servers[input.serverName] as ManifestServerEntry),
        links: dropKey(cursor.servers[input.serverName]?.links ?? {}, agent),
      })
    }
  }
  const nextManifest = removeServer(cursor, input.serverName)
  ops.push(manifestWriteOp(state, nextManifest))
  return {
    ops,
    nextManifest,
    serverName: input.serverName,
    unlinkedAgents,
    removedManifest: true,
  }
}

// -------------------------------------------------------------------
// planRescan: diff manifest links against what's on disk. Reports
// verified / drifted / missing entries. Does not mutate manifest.
// -------------------------------------------------------------------

export function planRescan(
  state: State,
  input?: RescanInput,
): { rescan: RescanReport; ops: FsOp[] } {
  const filter = input?.agents ? new Set(input.agents) : null
  const verified: RescanReport['verified'] extends ReadonlyArray<infer T>
    ? T[]
    : never = []
  const drifted: RescanReport['drifted'] extends ReadonlyArray<infer T>
    ? T[]
    : never = []
  const missing: RescanReport['missing'] extends ReadonlyArray<infer T>
    ? T[]
    : never = []

  for (const server of Object.values(state.manifest.servers)) {
    for (const [agentRaw, link] of Object.entries(server.links)) {
      if (!link) continue
      const agent = agentRaw as AgentId
      if (filter && !filter.has(agent)) continue
      const scope: AgentScope = 'system' // rescan reports both scopes if the file is included; scope is informational
      const file = findAgentFile(state, agent, scope, link.configPath)
      if (!file) {
        missing.push({
          serverName: server.name,
          agent,
          scope,
          configPath: link.configPath,
          reason: 'config file was not included in readState',
        })
        continue
      }
      if (!file.exists) {
        missing.push({
          serverName: server.name,
          agent,
          scope,
          configPath: link.configPath,
          reason: 'config file does not exist on disk',
        })
        continue
      }
      const client = getCatalogEntry(agent)
      const emitter = getEmitter(client, scope)
      const keys = emitter.read(file.rawContent)
      if (keys.includes(server.name)) {
        verified.push({
          serverName: server.name,
          agent,
          configPath: file.configPath,
        })
      } else {
        drifted.push({
          serverName: server.name,
          agent,
          scope,
          configPath: file.configPath,
          reason:
            'manifest link exists but on-disk config has no matching entry',
        })
      }
    }
  }
  return { rescan: { verified, drifted, missing }, ops: [] }
}

// -------------------------------------------------------------------
// Internals
// -------------------------------------------------------------------

function validateSpec(spec: McpServerSpec): void {
  if (spec.transport === 'stdio') {
    if (!spec.command?.trim()) {
      throw new InvalidServerSpecError(
        'stdio spec requires a non-empty command',
      )
    }
  } else if (spec.transport === 'sse' || spec.transport === 'http') {
    if (!spec.url?.trim()) {
      throw new InvalidServerSpecError(
        `${spec.transport} spec requires a non-empty url`,
      )
    }
  } else {
    throw new InvalidServerSpecError(
      `unknown spec transport ${JSON.stringify((spec as { transport: unknown }).transport)}`,
    )
  }
}

function ensureTransportSupported(
  agent: AgentId,
  scope: AgentScope,
  transport: McpServerSpec['transport'],
): void {
  const entry = getCatalogEntry(agent)
  const list =
    scope === 'project'
      ? (entry.supportedTransports.project ?? entry.supportedTransports.system)
      : entry.supportedTransports.system
  if (!list) throw new AgentNotSupportedError(agent)
  if (!list.includes(transport)) {
    throw new UnsupportedTransportError(agent, transport, {
      supported: list,
      hint: `Emit a ${list[0] ?? 'stdio'} spec for this agent or pick a different agent.`,
    })
  }
}

function requireServer(state: State, name: string): ManifestServerEntry {
  const server = state.manifest.servers[name]
  if (!server) throw new ServerNotFoundError(name)
  return server
}

function requireAgentFile(
  state: State,
  agent: AgentId,
  scope: AgentScope,
): AgentFileState {
  const file = state.agents.find((a) => a.agent === agent && a.scope === scope)
  if (!file) {
    throw new InvalidServerSpecError(
      `agent ${agent}@${scope} was not included in readState; add it to the agents list before planning`,
    )
  }
  return file
}

function findAgentFile(
  state: State,
  agent: AgentId,
  scope: AgentScope,
  configPath: string,
): AgentFileState | undefined {
  return (
    state.agents.find(
      (a) =>
        a.agent === agent && a.scope === scope && a.configPath === configPath,
    ) ??
    state.agents.find((a) => a.agent === agent && a.configPath === configPath)
  )
}

function putServer(
  manifest: ServerManifest,
  entry: ManifestServerEntry,
): ServerManifest {
  return {
    ...manifest,
    servers: { ...manifest.servers, [entry.name]: entry },
  }
}

function removeServer(manifest: ServerManifest, name: string): ServerManifest {
  const next = { ...manifest.servers }
  delete next[name]
  return { ...manifest, servers: next }
}

function dropKey<T extends Record<string, unknown>>(obj: T, key: string): T {
  const copy = { ...obj } as Record<string, unknown>
  delete copy[key]
  return copy as T
}

function writeOp(path: string, content: string): FsOp {
  return { kind: 'writeFile', path, content, ensureDir: true }
}

function manifestWriteOp(state: State, manifest: ServerManifest): FsOp {
  return writeOp(state.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

// Best-effort project-scope detection. Actual scope classification is
// done by the API layer that constructed State; this heuristic is only
// used inside planRemove when the manifest link record does not carry a
// scope tag (link records were written in v0.0.3 without scope metadata).
function deriveProjectPath(configPath: string): string {
  return configPath
}
