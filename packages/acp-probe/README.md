# acp-probe

> Probe any [Agent Client Protocol](https://agentclientprotocol.com)
> agent for its capabilities — models, modes, configOptions, prompt
> capabilities, auth methods, MCP transports — without sending a real
> prompt.

[![npm](https://img.shields.io/npm/v/acp-probe.svg)](https://www.npmjs.com/package/acp-probe)

> [!NOTE]
> **Stable.** As of `1.0.0` the public API is stable and ready for
> production use. Breaking changes follow semantic versioning and land
> only in major releases.

## What it does

Given an ACP-compatible agent (built-in like `claude` / `codex` /
`gemini` or any custom adapter you can spawn), `acp-probe` performs
the ACP `initialize` + `session/new` handshake, then optionally
pings `session/set_config_option` to test whether the agent
implements that method — agents like **gemini-cli** that don't
implement it respond with the standard JSON-RPC "method not found"
error, which the probe catches to flip `supportsConfigOption: false`
in the result. Finally the agent is torn down. The result is a
typed, schema-stable `AgentProbeResult` you can feed into a settings
UI, picker, or downstream `AcpRuntimeOptions` call.

**No LLM tokens are consumed.** `session/new` is free; we never call
`session/prompt`.

## Install

```bash
bun add acp-probe
# or
npm install acp-probe
```

The only hard dependency is
[`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk).
[`acpx`](https://www.npmjs.com/package/acpx) is an **optional peer**
— installed, it lets you use the built-in `{ agent: 'claude' }`
shorthand; absent, you pass `{ command }` or `{ argv }` yourself.

## Quickstart

```ts
import { probeAgent } from 'acp-probe'

// Custom ACP command — the canonical entry point. Zero acpx
// involvement; works with any agent you can spawn.
const result = await probeAgent({
  command: 'my-acp-agent --stdio',
})

console.log(result.models)         // ProbedModel[]
console.log(result.modes)          // ProbedMode[]
console.log(result.configOptions)  // ProbedConfigOption[]
console.log(result.reasoning)      // { configId, values, defaultValue } | null
console.log(result.capabilities.promptCapabilities)
//        => { image: boolean, audio: boolean, embeddedContext: boolean }

// Built-in shorthand — requires acpx to be installed.
const claude = await probeAgent({ agent: 'claude' })
```

## Result shape

```ts
interface AgentProbeResult {
  agent: {
    id: string | null
    command: string
    argv: readonly string[]
    probedAt: string  // ISO timestamp
    durationMs: number
  }
  protocolVersion: number
  agentInfo: { name; title?; version? } | null
  capabilities: {
    loadSession: boolean
    promptCapabilities: { image; audio; embeddedContext }
    mcpCapabilities: { http; sse; meta? }
    sessionCapabilities: { close; list; resume; fork; additionalDirectories }
    experimental?: { auth; nes; providers; positionEncoding }
  }
  authMethods: AuthMethod[]
  /**
   * Declarative `session/new.models.availableModels[]`. Best for display
   * — **may contain ids that `setConfigOption('model', X)` will not
   * accept**. See "Picking the right model list" below.
   */
  models: Array<{ id; name?; description? }>
  modes: Array<{ id; name?; description? }>
  configOptions: ProbedConfigOption[]
  /** Derived pointer to the configOption with category='thought_level'. */
  reasoning: { configId; values; defaultValue? } | null
  /**
   * Derived pointer to `configOptions[id=model]`. `values` are the ids
   * that `setConfigOption('model', X)` will accept. `null` when the
   * agent doesn't expose a settable model picker (e.g. gemini).
   */
  modelConfig: { configId; values; currentValue? } | null
  /**
   * True iff the agent implements `session/set_config_option`. False
   * when the agent responds with JSON-RPC "method not found" to a
   * no-op set call — that's how gemini-cli (and similar adapters that
   * skip configOptions support) signal the method is unimplemented.
   */
  supportsConfigOption: boolean
  error?: ProbeError
  /** Verbatim init + session/new responses for callers that need _meta. */
  raw: { initialize; newSession }
}
```

## Picking the right model list

The probe surfaces two model-related lists from ACP because the two
protocol surfaces don't always agree:

- **`result.models`** — the agent's declarative `availableModels[]` from
  `session/new`. Best for display / browsing / showing the user "what
  this agent can do". **May contain ids the agent will not accept as
  `setConfigOption('model', X)` inputs** — codex-acp, for example,
  advertises compound `<model>/<effort>` ids here that `setConfigOption`
  rejects (silently — the next prompt finishes with `finishReason:
  "error"` and no error frame).
- **`result.modelConfig.values`** — the string ids that the agent's
  `configOptions[id=model]` select will accept. `null` for agents that
  don't expose `configOptions[model]` at all (e.g. gemini, where
  `setConfigOption` itself returns `-32601 method not found`).
- **`result.configOptions.find(o => o.id === 'model')`** — the full typed
  picker option (names, descriptions, `currentValue`) for the settable
  values. Use this when you want to render a rich picker UI on top of
  the settable list.

### Display-only browser

```ts
import { probeAgent } from 'acp-probe'

const result = await probeAgent({ command: 'npx @zed-industries/codex-acp@^0.12.0' })

for (const m of result.models) {
  console.log(`${m.id}${m.name ? ` — ${m.name}` : ''}`)
}
```

### Mutable picker that drives `setConfigOption`

```ts
import { probeAgent } from 'acp-probe'

const result = await probeAgent({ command: 'npx @zed-industries/codex-acp@^0.12.0' })

if (!result.modelConfig) {
  console.log('This agent does not expose a model picker — skip the UI.')
} else {
  const { values, currentValue } = result.modelConfig
  for (const id of values) {
    console.log(id === currentValue ? `* ${id}` : `  ${id}`)
  }
}
```

### Rich mutable picker (values + names + descriptions)

```ts
import { probeAgent } from 'acp-probe'

const result = await probeAgent({ command: 'npx @zed-industries/codex-acp@^0.12.0' })

const modelOption = result.configOptions.find((o) => o.id === 'model')
if (modelOption?.type === 'select') {
  for (const opt of modelOption.options ?? []) {
    const tag = opt.value === modelOption.currentValue ? ' (current)' : ''
    console.log(`${opt.value} — ${opt.name}${tag}`)
    if (opt.description) console.log(`  ${opt.description}`)
  }
}
```

### Quick reference

| Use case | Field to read | Empty when |
|---|---|---|
| Display all advertised models | `result.models` | agent omitted `models` from `session/new` |
| Drive `setConfigOption('model', X)` | `result.modelConfig.values` | agent has no `configOptions[id=model]` |
| Rich picker UI (names + descriptions) | `result.configOptions.find(o => o.id === 'model')` | same as above |

## Errors

Two distinct error surfaces:

- **`AgentResolveError`** (thrown sync): caller passed `{ agent: <id> }`
  but acpx isn't installed / doesn't recognise the id. Includes
  `resolveCause: 'acpx_not_installed' | 'acpx_incompatible' | 'unknown_agent'`.
- **`AgentProbeResult.error`** (returned, not thrown): probe ran but
  couldn't complete cleanly. Includes `code: 'spawn_failed' |
  'initialize_timeout' | 'session_new_timeout' | 'auth_required' |
  'protocol_mismatch' | 'agent_crashed' | 'unknown'` plus `stderr` for
  debugging.

## Options

| option | type | default | notes |
|---|---|---|---|
| `agent` | `string` | — | Built-in agent id (requires acpx). |
| `command` | `string` | — | Raw command, shell-split. |
| `argv` | `readonly string[]` | — | Pre-split argv (takes precedence over `command`). |
| `cwd` | `string` | `process.cwd()` | Working dir for the spawned agent. |
| `env` | `Record<string, string>` | `{}` | Merged into the spawned process's env. |
| `authPolicy` | `'skip' \| 'fail'` | `'skip'` | `'skip'`: record `authMethods` and continue. `'fail'`: don't call `session/new`. |
| `timeoutMs` | `number` | `30_000` | Hard cap on the full probe lifecycle. |

Exactly one of `agent`, `command`, or `argv` is required.

## Captured fixtures (2026-05-14)

The repo ships recorded `initialize` + `session/new` responses for
claude / codex / gemini under `test/fixtures/`. They power the unit
test suite and document the per-agent capability matrix at the time
of capture.

## End-to-end probes against real agents

An opt-in suite under [`test/e2e/`](./test/e2e/README.md) runs the
probe against the locally-installed `claude` / `codex` / `gemini`
CLIs to catch upstream adapter drift the fixture tests can't see.
Each agent is probed twice — once via `{ agent: <id> }` (acpx
resolution) and once via `{ command: <hardcoded> }` (the no-acpx
path) — and the two results are asserted to be structurally
identical.

```bash
# Run all three agents
bun run test:e2e

# Or pick one
PROBE_E2E=claude bun test test/e2e
```

Not run in CI. Zero LLM tokens consumed. See the suite's README for
per-agent setup notes.

## Relationship to acpx

`acp-probe` is upstream of `acpx` in the data flow: probe → capabilities
→ feed `AcpRuntimeOptions`. The probe doesn't depend on acpx at
runtime unless you use the `{ agent: <id> }` shorthand, in which case
it lazy-imports `acpx/runtime` to resolve via acpx's built-in agent
registry. Custom-agent users never touch acpx.

## License

MIT — see [LICENSE](./LICENSE).
