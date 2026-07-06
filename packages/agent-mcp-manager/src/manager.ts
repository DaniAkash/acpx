import * as os from 'node:os'
import * as path from 'node:path'
import { atomicWriteFile, readFileOrEmpty } from './_internal/atomic-write.ts'
import { readManifest, writeManifest } from './_internal/manifest.ts'
import {
  getCatalogEntry,
  isAgentSupported,
  resolveAgentMcpConfigPath,
  resolveAgentSurface,
} from './agents.ts'
import type { AddServerResult } from './api.ts'
import { getEmitter } from './emitters/index.ts'
import {
  AgentNotSupportedError,
  ForeignEntryError,
  InvalidServerSpecError,
  McpManagerError,
  ServerNotFoundError,
  UnsupportedTransportError,
} from './errors.ts'
import type {
  AddServerOptions,
  AgentId,
  AgentScope,
  InstalledServer,
  LinkServerOptions,
  LinkServerResult,
  ListLinksOptions,
  ListServersOptions,
  ManifestServerEntry,
  McpManagerOptions,
  McpServerLink,
  McpServerSpec,
  RemoveServerOptions,
  RescanOptions,
  RescanResult,
  ServerManifest,
  UnlinkServerOptions,
  UnlinkServerResult,
} from './types.ts'

export interface McpManager {
  add(opts: AddServerOptions): Promise<AddServerResult>
  link(opts: LinkServerOptions): Promise<LinkServerResult>
  unlink(opts: UnlinkServerOptions): Promise<UnlinkServerResult>
  remove(opts: RemoveServerOptions): Promise<void>
  listServers(opts?: ListServersOptions): Promise<InstalledServer[]>
  listLinks(opts?: ListLinksOptions): Promise<McpServerLink[]>
  rescan(opts?: RescanOptions): Promise<RescanResult>
}

const ALL_AGENT_IDS: readonly AgentId[] = [
  'claude-code',
  'claude-desktop',
  'cursor',
  'vscode',
  'gemini',
  'codex',
  'zed',
]

function defaultWorkspaceDir(): string {
  return path.join(os.homedir(), '.acpx', 'mcp')
}

function validateSpec(spec: McpServerSpec): void {
  if (!spec || typeof spec !== 'object') {
    throw new InvalidServerSpecError('spec is required')
  }
  if (spec.transport === 'stdio') {
    if (!spec.command?.trim()) {
      throw new InvalidServerSpecError(
        'stdio.command is required and must be non-empty',
      )
    }
    return
  }
  if (spec.transport === 'sse' || spec.transport === 'http') {
    if (!spec.url?.trim()) {
      throw new InvalidServerSpecError(`${spec.transport}.url is required`)
    }
    try {
      // eslint-disable-next-line no-new
      new URL(spec.url)
    } catch {
      throw new InvalidServerSpecError(
        `${spec.transport}.url is not a valid URL`,
      )
    }
    return
  }
  throw new InvalidServerSpecError(
    `unknown transport "${(spec as { transport?: string }).transport ?? ''}"`,
  )
}

function validateName(name: string): string {
  if (typeof name !== 'string')
    throw new InvalidServerSpecError('name must be a string')
  const trimmed = name.trim()
  if (trimmed.length === 0)
    throw new InvalidServerSpecError('name must be non-empty')
  return trimmed
}

function assertSupported(agent: string): asserts agent is AgentId {
  if (!isAgentSupported(agent)) throw new AgentNotSupportedError(agent)
}

function transportHint(agent: AgentId, scope: AgentScope): string {
  if (agent === 'claude-desktop') {
    return (
      'Claude Desktop only accepts stdio MCP servers. Wrap the remote URL with ' +
      '`npx -y mcp-remote <url>` and re-add the server as a stdio spec.'
    )
  }
  if (agent === 'codex') {
    return (
      'Codex (~/.codex/config.toml) accepts stdio and streamable-HTTP MCP ' +
      'servers; SSE is not parsed. If the URL actually serves streamable ' +
      'HTTP, re-add the server with transport: "http" and the same URL. If ' +
      'the URL is SSE-only, wrap it with `npx -y mcp-remote <url>` and ' +
      're-add as a stdio spec.'
    )
  }
  if (agent === 'claude-code' && scope === 'project') {
    return (
      'Claude Code .mcp.json (project scope) only accepts stdio entries. Use ' +
      'system scope for sse/http, or wrap with `npx -y mcp-remote <url>`.'
    )
  }
  return 'This agent does not accept the requested transport.'
}

function assertTransportSupported(
  agent: AgentId,
  scope: AgentScope,
  spec: McpServerSpec,
): void {
  const { supportedTransports } = resolveAgentSurface(agent, scope)
  if (supportedTransports.includes(spec.transport)) return
  throw new UnsupportedTransportError(agent, spec.transport, {
    supported: supportedTransports,
    hint: transportHint(agent, scope),
  })
}

function withoutAgent<T>(
  links: Partial<Record<AgentId, T>>,
  agent: AgentId,
): Partial<Record<AgentId, T>> {
  const out: Partial<Record<AgentId, T>> = {}
  for (const [k, v] of Object.entries(links)) {
    if (k === agent) continue
    out[k as AgentId] = v as T
  }
  return out
}

function withoutServer(
  servers: Record<string, ManifestServerEntry>,
  name: string,
): Record<string, ManifestServerEntry> {
  const out: Record<string, ManifestServerEntry> = {}
  for (const [k, v] of Object.entries(servers)) {
    if (k === name) continue
    out[k] = v
  }
  return out
}

interface InternalCtx {
  workspaceDir: string
  scope: AgentScope
  projectRoot?: string
  overrides: Partial<Record<AgentId, string>>
}

async function resolvePath(
  ctx: InternalCtx,
  agent: AgentId,
  override?: string,
): Promise<string> {
  if (override) return override
  const mapped = ctx.overrides[agent]
  if (mapped) return mapped
  return resolveAgentMcpConfigPath(agent, ctx.scope, ctx.projectRoot)
}

async function unlinkImpl(
  ctx: InternalCtx,
  opts: UnlinkServerOptions,
): Promise<UnlinkServerResult> {
  const name = validateName(opts.serverName)
  assertSupported(opts.agent)
  const entry = getCatalogEntry(opts.agent)
  const emitter = getEmitter(entry, ctx.scope)

  const manifest = await readManifest(ctx.workspaceDir)
  const server = manifest.servers[name]
  const recorded = server?.links[opts.agent]
  const configPath = await resolvePath(
    ctx,
    opts.agent,
    opts.configPath ?? recorded?.configPath,
  )

  const raw = await readFileOrEmpty(configPath)
  const onDisk = raw.trim() ? emitter.read(raw).includes(name) : false

  if (!onDisk) {
    if (recorded && server) {
      const next: ServerManifest = {
        ...manifest,
        servers: {
          ...manifest.servers,
          [name]: { ...server, links: withoutAgent(server.links, opts.agent) },
        },
      }
      await writeManifest(ctx.workspaceDir, next)
    }
    return { serverName: name, agent: opts.agent, configPath, removed: false }
  }

  if (!recorded) {
    throw new ForeignEntryError(name, opts.agent, configPath)
  }

  const next = emitter.remove(raw, name)
  if (next !== raw) await atomicWriteFile(configPath, next)

  if (server) {
    const nextManifest: ServerManifest = {
      ...manifest,
      servers: {
        ...manifest.servers,
        [name]: { ...server, links: withoutAgent(server.links, opts.agent) },
      },
    }
    await writeManifest(ctx.workspaceDir, nextManifest)
  }

  return { serverName: name, agent: opts.agent, configPath, removed: true }
}

async function scanUnmanaged(
  ctx: InternalCtx,
  manifest: ServerManifest,
  agentFilter?: AgentId[],
): Promise<McpServerLink[]> {
  const out: McpServerLink[] = []
  const agents = agentFilter ?? ALL_AGENT_IDS
  const recordedByPath = new Map<string, Set<string>>()
  for (const server of Object.values(manifest.servers)) {
    for (const [agentRaw, link] of Object.entries(server.links)) {
      if (!link) continue
      const key = `${agentRaw}:${link.configPath}`
      let set = recordedByPath.get(key)
      if (!set) {
        set = new Set()
        recordedByPath.set(key, set)
      }
      set.add(server.name)
    }
  }
  for (const agent of agents) {
    const entry = getCatalogEntry(agent)
    const emitter = getEmitter(entry, ctx.scope)
    let configPath: string
    try {
      configPath = await resolvePath(ctx, agent)
    } catch {
      continue
    }
    const raw = await readFileOrEmpty(configPath)
    if (!raw.trim()) continue
    const onDisk = emitter.read(raw)
    const recorded =
      recordedByPath.get(`${agent}:${configPath}`) ?? new Set<string>()
    for (const name of onDisk) {
      if (recorded.has(name)) continue
      out.push({
        serverName: name,
        agent,
        configPath,
        unmanaged: true,
      })
    }
  }
  return out
}

export function createMcpManager(options: McpManagerOptions = {}): McpManager {
  const ctx: InternalCtx = {
    workspaceDir: options.workspaceDir ?? defaultWorkspaceDir(),
    scope: options.scope ?? 'system',
    projectRoot: options.projectRoot,
    overrides: options.agentConfigPaths ?? {},
  }

  // Serialise every state-mutating op so concurrent callers (e.g. fanning
  // out `link` across all detected agents) can't race on read→modify→write
  // of either the workspace manifest or an agent config file.
  let writeQueue: Promise<unknown> = Promise.resolve()
  const enqueueWrite = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = writeQueue.then(fn, fn)
    writeQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  return {
    add(opts: AddServerOptions): Promise<AddServerResult> {
      const name = validateName(opts.name)
      validateSpec(opts.spec)
      return enqueueWrite(async () => {
        const manifest = await readManifest(ctx.workspaceDir)
        const existing = manifest.servers[name]
        const next: ManifestServerEntry = {
          name,
          spec: opts.spec,
          addedAt: existing?.addedAt ?? new Date().toISOString(),
          links: existing?.links ?? {},
        }
        const updated: ServerManifest = {
          ...manifest,
          servers: { ...manifest.servers, [name]: next },
        }
        await writeManifest(ctx.workspaceDir, updated)
        return { name, created: !existing }
      })
    },

    link(opts: LinkServerOptions): Promise<LinkServerResult> {
      const name = validateName(opts.serverName)
      assertSupported(opts.agent)
      const entry = getCatalogEntry(opts.agent)
      const emitter = getEmitter(entry, ctx.scope)
      return enqueueWrite(async () => {
        const configPath = await resolvePath(ctx, opts.agent, opts.configPath)
        const manifest = await readManifest(ctx.workspaceDir)
        const server = manifest.servers[name]
        if (!server) throw new ServerNotFoundError(name)

        // Transport-capability gate fires before any IO on the agent's
        // config file (the workspace manifest has already been read and
        // the config path resolved at this point, but nothing has been
        // read or written on the agent side). Callers get a typed
        // error before the agent's config is opened. The check uses
        // ctx.scope so claude-code can be stdio-only on project scope
        // and accept-all on system scope.
        assertTransportSupported(opts.agent, ctx.scope, server.spec)

        const raw = await readFileOrEmpty(configPath)
        const existing = server.links[opts.agent]
        const alreadyOnDisk = raw.trim()
          ? emitter.read(raw).includes(name)
          : false

        // Idempotent: same agent, same path, entry already present.
        if (existing && existing.configPath === configPath && alreadyOnDisk) {
          return {
            serverName: name,
            agent: opts.agent,
            configPath,
            created: false,
          }
        }

        // Refuse to clobber an entry the manifest didn't write unless
        // the caller explicitly opts in via allowOverwrite. The default
        // is a safety rail: another tool may have placed this entry
        // and we shouldn't rewrite it silently.
        if (alreadyOnDisk && !existing && !opts.allowOverwrite) {
          throw new ForeignEntryError(name, opts.agent, configPath)
        }

        const updated = emitter.add(raw, name, server.spec)
        if (updated !== raw) await atomicWriteFile(configPath, updated)

        const nextManifest: ServerManifest = {
          ...manifest,
          servers: {
            ...manifest.servers,
            [name]: {
              ...server,
              links: {
                ...server.links,
                [opts.agent]: {
                  configPath,
                  createdAt: new Date().toISOString(),
                },
              },
            },
          },
        }
        await writeManifest(ctx.workspaceDir, nextManifest)
        return {
          serverName: name,
          agent: opts.agent,
          configPath,
          created: true,
        }
      })
    },

    unlink: (opts) => enqueueWrite(() => unlinkImpl(ctx, opts)),

    async remove(opts: RemoveServerOptions): Promise<void> {
      const name = validateName(opts.serverName)
      // Per-agent unlinks each take the queue; the final manifest write
      // also goes through the queue. So 'remove' as a whole isn't atomic
      // against an interleaved 'add', but each individual mutation is —
      // matching skills-manager's posture.
      const manifest = await readManifest(ctx.workspaceDir)
      const server = manifest.servers[name]
      if (!server) throw new ServerNotFoundError(name)

      if (opts.unlinkFirst !== false) {
        for (const agent of Object.keys(server.links) as AgentId[]) {
          try {
            await enqueueWrite(() =>
              unlinkImpl(ctx, { serverName: name, agent }),
            )
          } catch (err) {
            if (err instanceof ForeignEntryError) continue
            throw err
          }
        }
      }

      await enqueueWrite(async () => {
        const fresh = await readManifest(ctx.workspaceDir)
        await writeManifest(ctx.workspaceDir, {
          ...fresh,
          servers: withoutServer(fresh.servers, name),
        })
      })
    },

    async listServers(
      _opts: ListServersOptions = {},
    ): Promise<InstalledServer[]> {
      const manifest = await readManifest(ctx.workspaceDir)
      return Object.values(manifest.servers).map((s) => ({
        name: s.name,
        spec: s.spec,
        addedAt: s.addedAt,
        links: s.links,
      }))
    },

    async listLinks(opts: ListLinksOptions = {}): Promise<McpServerLink[]> {
      const manifest = await readManifest(ctx.workspaceDir)
      const out: McpServerLink[] = []
      const filterAgents = opts.agents ? new Set(opts.agents) : null
      const filterNames = opts.serverNames ? new Set(opts.serverNames) : null
      for (const server of Object.values(manifest.servers)) {
        if (filterNames && !filterNames.has(server.name)) continue
        for (const [agentRaw, link] of Object.entries(server.links)) {
          const agent = agentRaw as AgentId
          if (filterAgents && !filterAgents.has(agent)) continue
          if (!link) continue
          out.push({
            serverName: server.name,
            agent,
            configPath: link.configPath,
          })
        }
      }
      if (opts.scanUnmanaged) {
        for (const link of await scanUnmanaged(ctx, manifest, opts.agents))
          out.push(link)
      }
      return out
    },

    async rescan(opts: RescanOptions = {}): Promise<RescanResult> {
      const mode = opts.mode ?? 'merge'
      if (mode === 'replace') {
        throw new McpManagerError(
          "rescan mode 'replace' is not implemented; use 'merge'",
        )
      }
      const manifest = await readManifest(ctx.workspaceDir)
      const verified: McpServerLink[] = []
      const broken: McpServerLink[] = []

      for (const server of Object.values(manifest.servers)) {
        for (const [agentRaw, link] of Object.entries(server.links)) {
          const agent = agentRaw as AgentId
          if (!link) continue
          const entry = getCatalogEntry(agent)
          const emitter = getEmitter(entry, ctx.scope)
          const raw = await readFileOrEmpty(link.configPath)
          const names = raw.trim() ? emitter.read(raw) : []
          if (!names.includes(server.name)) {
            broken.push({
              serverName: server.name,
              agent,
              configPath: link.configPath,
              broken: true,
            })
            continue
          }
          verified.push({
            serverName: server.name,
            agent,
            configPath: link.configPath,
          })
        }
      }

      const unmanaged = await scanUnmanaged(ctx, manifest)

      // Drift detection (deep compare of spec) deferred to v0.2.
      return { verified, drifted: [], broken, unmanaged }
    },
  }
}
