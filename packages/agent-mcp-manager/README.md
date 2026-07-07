# agent-mcp-manager

> Programmatic add/link/unlink for **Model Context Protocol** servers
> across 23 AI coding agents. Functional API, dry-run capable, 23-client
> catalog with per-client shape declarations.

> [!WARNING]
> **v0.0.4 is a breaking release.** The `createMcpManager` class API
> has been removed and replaced with a functional surface. See the
> [Migration guide](#migration-from-v003) below for a mechanical
> translation table. If you cannot migrate immediately, pin
> `agent-mcp-manager@^0.0.3`.

> [!WARNING]
> **Experimental.** The 0.0.x line is under active development. The
> public API may change between patch versions. Pin exact versions.

`agent-mcp-manager` writes MCP server entries into the real config
files that AI coding agents read on launch. Claude Desktop's
`claude_desktop_config.json`, Cursor's `~/.cursor/mcp.json`, VS Code's
`mcp.json`, Codex's `~/.codex/config.toml`, and 19 others across
JSON / JSONC / YAML / TOML. It targets embedders (IDE plugins,
internal tools, enterprise onboarding flows, custom installers) that
need to register MCP servers programmatically across many agents.

## Install

```sh
bun add agent-mcp-manager
# or: npm i, pnpm add, yarn add
```

## Quick start

```ts
import {
  addServer,
  link,
  disconnect,
  bind,
} from 'agent-mcp-manager'

const workspaceDir = '~/.myapp/mcp'

// 1. Register a server in the workspace manifest.
await addServer(workspaceDir, {
  name: 'github',
  spec: {
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp',
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}` },
  },
})

// 2. Link the server into each agent's on-disk config.
await link(workspaceDir, { serverName: 'github', agent: 'cursor' })
await link(workspaceDir, { serverName: 'github', agent: 'claude-code' })
await link(workspaceDir, { serverName: 'github', agent: 'vscode' })

// 3. Later, disconnect one agent without affecting the others.
await disconnect(workspaceDir, {
  serverName: 'github',
  agent: 'cursor',
  removeIfLast: true,   // drop the manifest entry only if no agents remain
})

// For consumers who use the same workspaceDir across many calls:
const mgr = bind(workspaceDir)
await mgr.link({ serverName: 'github', agent: 'gemini' })
```

## API reference

### Verbs

| Verb | Signature | Purpose |
|---|---|---|
| `addServer` | `(workspaceDir, {name, spec}) => Promise<{name, created}>` | Register a server spec in the workspace manifest. Idempotent (re-adds update the spec, preserve `addedAt` and links). Trims the name; the returned `name` reflects what was persisted. |
| `link` | `(workspaceDir, {serverName, agent, scope?, projectRoot?, configPath?, allowOverwrite?}) => Promise<LinkPlanSummary>` | Write the server into one agent's config file and record the link in the manifest. |
| `unlink` | `(workspaceDir, {serverName, agent, scope?, projectRoot?, configPath?}) => Promise<UnlinkPlanSummary>` | Remove one agent's entry from its config file and drop the manifest link. No-op when the manifest has no such link. |
| `disconnect` | `(workspaceDir, {serverName, agent, scope?, projectRoot?, removeIfLast?}) => Promise<DisconnectPlanSummary>` | Unlink one agent AND drop the manifest entry when no other agents remain linked to it. Never touches other agents' config files. **The primitive that closes [issue #63](https://github.com/DaniAkash/agent-toolkit/issues/63).** |
| `remove` | `(workspaceDir, {serverName, unlinkFirst?}) => Promise<RemovePlanSummary>` | Drop the manifest entry AND unlink every currently-linked agent's config file. |
| `list` | `(workspaceDir) => Promise<ManifestServerEntry[]>` | Every server in the manifest. |
| `listLinks` | `(workspaceDir, {serverNames?, agents?}?) => Promise<ListedLink[]>` | Every (server, agent, configPath) triple in the manifest. Filter by server name or agent. |
| `rescan` | `(workspaceDir, {agents?}?) => Promise<RescanReport>` | Diff manifest links against disk. Reports verified / drifted / missing entries. |
| `bind` | `(workspaceDir) => BoundApi` | Sugar for calling all verbs with the same workspaceDir. Stateless: every method still runs `readState -> plan -> applyPlan`. |

### Errors

Every error extends `McpManagerError`. `instanceof` checks are safe across module boundaries.

| Error | Thrown by | Meaning |
|---|---|---|
| `AgentNotSupportedError` | any verb | Agent id not in the catalog. |
| `ServerNotFoundError` | `link` | Server name not in the manifest (add it first). |
| `ForeignEntryError` | `link` | On-disk entry under the target name was not put there by the manifest. Pass `allowOverwrite: true` to take ownership. |
| `UnsupportedTransportError` | `link` | Transport not accepted by this agent at this scope. Details include the accepted set and a per-agent hint. |
| `InvalidServerSpecError` | `addServer` | Spec is missing required fields (empty command, empty url, unknown transport). |
| `UnresolvedConfigPathError` | any verb that needs the on-disk path | Cannot resolve the agent's config file on this OS (e.g., project scope requested without `projectRoot`, env vars unset). |

### Return summaries

Every mutating verb returns a summary describing what actually happened:

```ts
interface LinkPlanSummary {
  serverName: string
  agent: AgentId
  scope: AgentScope
  created: boolean           // true if no prior link existed; false if we replaced one
  overwroteForeign: boolean  // true if allowOverwrite: true replaced an unmanaged entry
}

interface UnlinkPlanSummary {
  serverName: string
  agent: AgentId
  scope: AgentScope
  removed: boolean           // true if there was actually a link to remove
}

interface DisconnectPlanSummary {
  serverName: string
  agent: AgentId
  scope: AgentScope
  unlinked: boolean          // true if we removed a link record
  removedManifest: boolean   // true if we dropped the manifest entry (last link + removeIfLast)
}

interface RemovePlanSummary {
  serverName: string
  unlinkedAgents: AgentId[]  // every agent whose config file was rewritten
  removedManifest: boolean
}
```

## Migration from v0.0.3

If you're on v0.0.3 with `createMcpManager`, you have three paths:

1. **Migrate to the functional API** (recommended). This section gives you the mechanical translations.
2. **Pin v0.0.3** with `"agent-mcp-manager": "^0.0.3"` in your package.json. The v0.0.3 line is unmaintained but functional; it stays on npm.
3. **Wait**. No compat shim is planned. v0.0.5+ builds on the functional surface.

### What changed and why

The v0.0.3 `createMcpManager()` returned an object with a private `manifest` reference that mutated across method calls. This produced a real bug ([#63](https://github.com/DaniAkash/agent-toolkit/issues/63)): the "disconnect one agent" flow required a three-line dance (`unlink` + `listLinks` + conditional `remove`), and any race or logic bug in the caller could silently orphan other agents' link records.

Under v0.0.4:

- **No mutable in-memory manifest.** Every verb reads the manifest from disk at call time, computes a plan, applies it.
- **Every operation composes.** `readState → plan* → applyPlan`. You can inspect the plan before writing.
- **`disconnect()` is one primitive.** It reads state, unlinks one agent, drops the manifest entry only if no other agents remain linked. Never touches other agents' config files. The #63 bug is structurally impossible.
- **The workspace manifest schema on disk is unchanged.** If you have a `manifest.json` written by v0.0.3, v0.0.4 reads it without migration.

### Migration table

| v0.0.3 (class API) | v0.0.4 (functional API) |
|---|---|
| `const mgr = createMcpManager({ workspaceDir })` | `const mgr = bind(workspaceDir)` (optional; the raw verbs also work) |
| `await mgr.add({ name, spec })` | `await addServer(workspaceDir, { name, spec })` |
| `await mgr.link({ serverName, agent })` | `await link(workspaceDir, { serverName, agent })` |
| `await mgr.link({ serverName, agent, configPath })` | `await link(workspaceDir, { serverName, agent, configPath })` |
| `await mgr.link({ serverName, agent, allowOverwrite: true })` | `await link(workspaceDir, { serverName, agent, allowOverwrite: true })` |
| `await mgr.unlink({ serverName, agent })` | `await unlink(workspaceDir, { serverName, agent })` |
| `await mgr.remove({ serverName })` | `await remove(workspaceDir, { serverName })` |
| `await mgr.remove({ serverName, unlinkFirst: false })` | `await remove(workspaceDir, { serverName, unlinkFirst: false })` |
| `await mgr.listServers()` | `await list(workspaceDir)` |
| `await mgr.listLinks()` | `await listLinks(workspaceDir)` |
| `await mgr.listLinks({ agents, serverNames })` | `await listLinks(workspaceDir, { agents, serverNames })` |
| `await mgr.rescan()` | `await rescan(workspaceDir)` |

### The disconnect pattern (the #63 fix)

If your v0.0.3 code has this pattern:

```ts
// v0.0.3 (buggy: can orphan other agents' links)
await mgr.unlink({ serverName, agent })
const links = await mgr.listLinks({ serverNames: [serverName] })
if (links.length === 0) {
  await mgr.remove({ serverName })
}
```

Replace it with a single call:

```ts
// v0.0.4 (structural fix)
await disconnect(workspaceDir, {
  serverName,
  agent,
  removeIfLast: true,  // default is true; can pass false to keep the entry
})
```

The v0.0.4 `disconnect` reads the manifest once, computes the post-unlink links map, and only drops the manifest entry when that map is empty. It never touches any other agent's config file. If two callers race, each reads a fresh manifest at call time; the last writer wins on the manifest, and neither ever touches an unrelated agent's config.

### Manager options

v0.0.3 accepted per-manager configuration through `McpManagerOptions`. Those knobs are now per-call:

| v0.0.3 `McpManagerOptions` field | v0.0.4 equivalent |
|---|---|
| `workspaceDir` | The first positional argument to every verb (or `bind(workspaceDir)` for sugar) |
| `scope` | Pass `scope: 'system' \| 'project'` per call |
| `projectRoot` | Pass `projectRoot: string` per call (required when `scope: 'project'`) |
| `agentConfigPaths` | Pass `configPath: string` per call to override the resolved path for that call |

Rationale: v0.0.3's per-manager `agentConfigPaths` map applied to every method call, which made mixed-scope operations awkward. v0.0.4's per-call `configPath` is one field with the same effect and no hidden state.

### `listServers` return shape

v0.0.3 `mgr.listServers()` returned `InstalledServer[]`. v0.0.4 `list(workspaceDir)` returns `ManifestServerEntry[]`. The two are the same shape (`{name, spec, addedAt, links}`) with a different type name; existing consumer code that reads `.name`, `.spec`, `.addedAt`, `.links` needs no change.

### `listLinks` return shape

v0.0.3 `mgr.listLinks()` returned `McpServerLink[]` with fields `serverName`, `agent`, `configPath`, and optional `drifted` / `broken` / `unmanaged` flags. v0.0.4 `listLinks(workspaceDir)` returns `ListedLink[]` with fields `serverName`, `agent`, `configPath`. The drift flags moved to a dedicated verb: call `rescan(workspaceDir)` for a `{verified, drifted, missing}` report.

### `rescan` return shape

v0.0.3 `RescanResult` had four buckets: `verified`, `drifted`, `broken`, `unmanaged`. v0.0.4 `RescanReport` has three: `verified`, `drifted`, `missing`. The v0.0.3 `broken` bucket is now folded into `missing` (a manifest link with no on-disk entry). v0.0.3's `unmanaged` bucket (on-disk entries with no manifest record) is not currently scanned by `rescan`; that's a v0.0.5 candidate.

### New capabilities in v0.0.4

Available today; no equivalent in v0.0.3:

- **Dry-run.** Import from `agent-mcp-manager/lowlevel` and call `planLink` / `planDisconnect` / etc. without applying. Inspect `plan.ops` (the exact file writes) and `plan.nextManifest` (the manifest snapshot) before deciding to apply. Example under "Dry-run and batching" below.
- **Batching.** Run multiple planner calls against a single `State` snapshot, concatenate the `ops`, and apply them all in one pass with `applyPlan`.
- **16 additional clients.** `cline`, `opencode`, `goose`, `kiro`, `windsurf`, `witsy`, `roocode`, `enconvo`, `boltai`, `amazon-bedrock`, `amazonq`, `tome`, `librechat`, `antigravity`, `trae`, `vscode-insiders`.

### Known behavioral differences

- **Trimmed names.** `addServer({ name: '  gh  ' })` persists the trimmed key `'gh'` and returns `{ name: 'gh', created }`. v0.0.3 persisted the untrimmed value, which produced entries that later verbs couldn't reference by the trimmed name.
- **Idempotent re-links skip the config write.** `link()` no longer touches mtime when the resulting content is identical. IDE file-watchers (Cursor, VS Code) no longer reload on idempotent re-runs.
- **`exists: true` for empty files.** `readState` from `/lowlevel` returns `AgentFileState.exists = true` for existing empty files; v0.0.3 conflated existence with non-emptiness.
- **`unlink` uses the manifest-recorded configPath.** If you `link({ configPath: X })` in v0.0.3 and later `unlink()` without a `configPath`, v0.0.3 rewrote the OS-default path (potentially skipping the file that had the entry). v0.0.4 looks up the recorded path from the manifest first.

### If you consumed `McpManager` as a type

v0.0.3 exported the `McpManager` interface for consumers to store the manager instance in class fields or React refs. v0.0.4 has no equivalent because the verbs are free functions. Two options:

```ts
// Option A: store the workspaceDir, call the free functions on demand.
class MyApp {
  private workspaceDir = '~/.myapp/mcp'
  async link(serverName: string, agent: AgentId) {
    await link(this.workspaceDir, { serverName, agent })
  }
}

// Option B: store a BoundApi.
import { bind, type BoundApi } from 'agent-mcp-manager'
class MyApp {
  private mcp: BoundApi = bind('~/.myapp/mcp')
  async link(serverName: string, agent: AgentId) {
    await this.mcp.link({ serverName, agent })
  }
}
```

Both are stateless: every method call re-reads the manifest from disk.

## Dry-run and batching

Import from `agent-mcp-manager/lowlevel` for the pure planner primitives plus `readState` and `applyPlan`. Every verb returns a `Plan` you can inspect before touching disk.

```ts
import {
  readState,
  planLink,
  planDisconnect,
  applyPlan,
} from 'agent-mcp-manager/lowlevel'

const state = await readState(workspaceDir, ['cursor', 'gemini'])

// Compute both plans against the SAME state snapshot.
const linkPlan = planLink(state, { serverName: 'gh', agent: 'cursor' }, new Date().toISOString())
const disconnectPlan = planDisconnect(state, { serverName: 'old', agent: 'gemini' })

// Inspect before writing.
console.log('link ops:', linkPlan.ops)
console.log('disconnect ops:', disconnectPlan.ops)

// Apply when ready. Each plan is independent; combined ops write once.
await applyPlan({
  ops: [...linkPlan.ops, ...disconnectPlan.ops],
  nextManifest: disconnectPlan.nextManifest,
})
```

`FsOp` is a discriminated union:

```ts
type FsOp =
  | { kind: 'writeFile'; path: string; content: string; ensureDir?: boolean }
  | { kind: 'removeFile'; path: string }
```

Every write goes through atomic `<file>.tmp + rename`.

## Supported clients

23 clients ship in v0.0.4 with hand-authored per-client shape declarations. See `src/_catalog/client-configs.ts` for the source of truth, including each entry's citation URLs.

| Established | Well-documented | Additional |
|---|---|---|
| claude-desktop | cline | amazon-bedrock |
| claude-code | opencode | amazonq |
| cursor | goose | antigravity |
| vscode | kiro | boltai |
| vscode-insiders | windsurf | enconvo |
| gemini | witsy | librechat |
| codex | roocode | tome |
| zed |  | trae |

Every catalog entry has:

- A first-party MCP docs URL as its primary source.
- A Smithery cross-check URL (design reference, AGPL-3.0; see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)).
- An ISO `verified` date. The catalog validator rejects any entry more than 12 months stale.

## Transport support and safety guarantees

Each client declares which transports it accepts (stdio / sse / http). Writing an entry with an unsupported transport throws `UnsupportedTransportError` **before** any file write. Concrete examples:

- Claude Desktop is stdio-only; an HTTP spec throws.
- Claude Code project scope (`.mcp.json`) is stdio-only; system scope (`~/.claude.json`) accepts all three.
- Codex accepts stdio and streamable HTTP but not SSE.

On disk:

- **Atomic writes.** Every edit goes through `<file>.tmp + rename`. A crashed process never leaves a half-written config file.
- **Foreign-entry protection.** `link` throws `ForeignEntryError` when an on-disk entry under the target name was not put there by the manifest. Pass `allowOverwrite: true` to take ownership.
- **Structural protection against orphaning.** `disconnect` computes its ops from the manifest's links map. Under this shape, disconnecting one agent from a server that four others share never touches the four others' config files. The v0.0.3 class API had a bug (issue #63) where `remove` blew away shared manifest entries. That bug is structurally impossible under the FP API.
- **Idempotent writes.** Re-linking a server that's already correctly present skips the file write entirely. Editors watching the config file do not reload.

## Types

Everything you need is at the package root or under `agent-mcp-manager/lowlevel`. Import paths:

```ts
import type {
  McpServerSpec,          // stdio | sse | http
  McpStdioSpec,
  McpHttpSpec,
  McpSseSpec,
  AgentId,                // union of 23 client ids
  AgentScope,             // 'system' | 'project'
  ServerManifest,         // on-disk schema
  ManifestServerEntry,
  ManifestLinkEntry,
  AddServerResult,
  LinkPlanSummary,
  UnlinkPlanSummary,
  DisconnectPlanSummary,
  RemovePlanSummary,
  RescanReport,
  BoundApi,
} from 'agent-mcp-manager'

import type {
  State, Plan, FsOp,
  LinkInput,
  DisconnectInput,
  // ... every planner input and result summary
} from 'agent-mcp-manager/lowlevel'
```

## Contributing

Author under MIT. Every catalog entry needs a first-party docs URL and an ISO `verified` date; the validator enforces both. Test files live next to the source folders they exercise.

License: MIT. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for research references.
