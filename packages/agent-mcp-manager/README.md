# agent-mcp-manager

> Programmatic add/link/unlink for **Model Context Protocol** servers
> across 23 AI coding agents. Functional API, dry-run capable, 23-client
> catalog with per-client shape declarations.

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

## Verbs

| Verb | Purpose |
|---|---|
| `addServer` | Register a server spec in the workspace manifest. Idempotent (re-adds update the spec, preserve `addedAt` and links). |
| `link` | Write the server into one agent's config file and record the link in the manifest. Throws `ForeignEntryError` if an entry under that name already exists on disk without a manifest record; pass `allowOverwrite: true` to take ownership. Throws `UnsupportedTransportError` when the transport is not accepted by that agent + scope. |
| `unlink` | Remove one agent's entry from its config file and drop the manifest link. No-op when the manifest has no such link. |
| `disconnect` | Unlink one agent AND drop the manifest entry when no other agents remain linked to it. Never touches other agents' config files. **The primitive that closes [issue #63](https://github.com/DaniAkash/agent-toolkit/issues/63).** |
| `remove` | Drop the manifest entry AND unlink every currently-linked agent's config file. |
| `list` | Every server in the manifest. |
| `listLinks` | Every (server, agent, configPath) triple in the manifest. Filter by server name or agent. |
| `rescan` | Diff manifest links against disk. Reports verified / drifted / missing entries. |
| `bind(workspaceDir)` | Sugar for calling all verbs with the same workspaceDir. Stateless: every method still runs `readState -> plan -> applyPlan`. |

## Migration from v0.0.3

The class API (`createMcpManager`) is removed in v0.0.4.

| Operation | v0.0.3 (class) | v0.0.4 (functional) |
|---|---|---|
| Add a server | `mgr.add({ name, spec })` | `addServer(workspaceDir, { name, spec })` |
| Link an agent | `mgr.link({ serverName, agent })` | `link(workspaceDir, { serverName, agent })` |
| Unlink an agent | `mgr.unlink({ serverName, agent })` | `unlink(workspaceDir, { serverName, agent })` |
| Disconnect one agent + tidy | `unlink` + `listLinks` + conditional `remove` (three lines) | `disconnect(workspaceDir, { serverName, agent, removeIfLast: true })` |
| Remove a server entirely | `mgr.remove({ serverName })` | `remove(workspaceDir, { serverName })` |
| Repeated calls (same workspace) | `const mgr = createMcpManager({workspaceDir}); mgr.link(...)` | `const mgr = bind(workspaceDir); await mgr.link(...)` |
| Dry-run | Not supported | See "Dry-run and batching" below |

The workspace manifest schema on disk is unchanged. Consumers reading the manifest file directly do not need to migrate.

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

## Errors

- `AgentNotSupportedError`: agent id not in the catalog.
- `ServerNotFoundError`: server name not in the manifest.
- `ForeignEntryError`: on-disk entry under the target name is not manifest-managed. Pass `allowOverwrite: true` to take ownership.
- `UnsupportedTransportError`: transport not accepted by this agent + scope.
- `InvalidServerSpecError`: spec is missing required fields (empty command, empty url, unknown transport).
- `UnresolvedConfigPathError`: cannot resolve the agent's config file on this OS (e.g., project scope requested without `projectRoot`).
- All extend `McpManagerError`.

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
} from 'agent-mcp-manager'

import type {
  State, Plan, FsOp,
  LinkInput, LinkPlanSummary,
  DisconnectInput, DisconnectPlanSummary,
  // ... every planner input and result summary
} from 'agent-mcp-manager/lowlevel'
```

## Contributing

Author under MIT. Every catalog entry needs a first-party docs URL and an ISO `verified` date; the validator enforces both. Test files live next to the source folders they exercise.

License: MIT. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for research references.
