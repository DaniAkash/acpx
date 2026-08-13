export interface AgentInfo {
  name: string
  title?: string
  version?: string
}

export interface PromptCapabilities {
  image: boolean
  audio: boolean
  embeddedContext: boolean
}

export interface McpCapabilities {
  http: boolean
  sse: boolean
  /** Any extension keys we didn't explicitly model. */
  meta?: Record<string, unknown>
}

export interface SessionCapabilities {
  close: boolean
  list: boolean
  resume: boolean
  fork: boolean
  additionalDirectories: boolean
}

export interface AgentCapabilities {
  loadSession: boolean
  promptCapabilities: PromptCapabilities
  mcpCapabilities: McpCapabilities
  sessionCapabilities: SessionCapabilities
  /**
   * Experimental ACP capabilities surfaced verbatim. Typed as `unknown`
   * until they stabilise; consumers can index into them at their own risk.
   */
  experimental?: {
    auth?: unknown
    nes?: unknown
    providers?: unknown
    positionEncoding?: unknown
  }
}

export interface AuthMethod {
  id: string
  name: string
  description?: string
  type?: 'env_var' | 'terminal' | 'agent' | string
  /** Env vars the method needs (`env_var` type only). */
  vars?: Array<{ name: string }>
  /** Arbitrary `_meta` the adapter attached. */
  meta?: Record<string, unknown>
}

export interface ProbedModel {
  id: string
  name?: string
  description?: string
}

export interface ProbedMode {
  id: string
  name?: string
  description?: string
}

export interface ProbedConfigOptionValue {
  value: string
  name?: string
  description?: string
}

export interface ProbedConfigOption {
  id: string
  name: string
  description?: string
  category?: 'mode' | 'model' | 'model_config' | 'thought_level' | string
  type: 'select' | 'boolean'
  /**
   * For `type === 'select'`: the currently-selected value id (string).
   * For `type === 'boolean'`: the current boolean state.
   */
  currentValue: string | boolean
  /** Populated for `type === 'select'` only. */
  options?: ProbedConfigOptionValue[]
}

export interface ReasoningInfo {
  /** configId the agent uses for its thought_level option. */
  configId: string
  values: string[]
  defaultValue?: string
}

export interface ModelConfigInfo {
  /** The configOption id to pass to `setConfigOption` (usually `'model'`). */
  configId: string
  /** Ids that `setConfigOption(configId, X)` will accept on this agent. */
  values: string[]
  /** Currently-selected value at probe time, if the agent advertised one. */
  currentValue?: string
}

export type ProbeErrorCode =
  | 'spawn_failed'
  | 'initialize_timeout'
  | 'session_new_timeout'
  | 'auth_required'
  | 'protocol_mismatch'
  | 'agent_crashed'
  | 'unknown'

export interface ProbeError {
  code: ProbeErrorCode
  message: string
  stderr?: string
  /** ACP JSON-RPC error if the agent returned one. */
  acpError?: { code: number; message: string; data?: unknown }
}

export interface AgentProbeRequest {
  /** Built-in agent id resolved via `acpx/runtime` (if installed). */
  agent?: string
  /** Raw command string — shell-split into argv. */
  command?: string
  /** Pre-split argv. Takes precedence over `command`. */
  argv?: readonly string[]
  /** Working directory for the spawned agent. Defaults to `process.cwd()`. */
  cwd?: string
  /** Environment variables to merge into the spawned process's env. */
  env?: Readonly<Record<string, string>>
  /**
   * What to do when the agent advertises `authMethods` and we don't have
   * credentials. `'skip'` (default) records the methods and continues with
   * `session/new` anyway. `'fail'` returns a probe error with code
   * `auth_required` without sending `session/new`.
   */
  authPolicy?: 'skip' | 'fail'
  /** Hard cap on the entire probe lifecycle (ms). Default 30_000. */
  timeoutMs?: number
}

export interface AgentProbeResult {
  /** Resolution + execution metadata. */
  agent: {
    /** Built-in agent id if `{ agent }` was passed; otherwise null. */
    id: string | null
    /** Spawn command, re-joined for display. */
    command: string
    /** Argv that was actually passed to `spawn()`. */
    argv: readonly string[]
    /** ISO timestamp at probe start. */
    probedAt: string
    /** End-to-end probe duration in milliseconds. */
    durationMs: number
  }

  protocolVersion: number
  agentInfo: AgentInfo | null
  capabilities: AgentCapabilities
  authMethods: AuthMethod[]
  /**
   * The models the agent's settable model picker exposes.
   *
   * ACP 1.x removed the separate declarative
   * `session/new.models.availableModels` list, so this is now sourced from
   * the model-selector config option: the ids ARE valid
   * `setConfigOption(modelConfig.configId, X)` inputs (the same values as
   * `modelConfig.values`), carrying the per-model `name` / `description`
   * the selector advertises. Empty when the agent exposes no model picker
   * (e.g. gemini).
   */
  models: ProbedModel[]
  modes: ProbedMode[]
  configOptions: ProbedConfigOption[]
  /**
   * Derived pointer to the thought_level configOption if present.
   * `null` when the agent doesn't expose a reasoning surface (e.g. gemini).
   */
  reasoning: ReasoningInfo | null
  /**
   * Derived pointer to the `configOptions[id=model]` select if present.
   * Its `values` are the ids `setConfigOption('model', X)` will accept.
   * `null` when the agent doesn't expose a settable model picker (e.g.
   * gemini, where `setConfigOption` returns `-32601 method not found`).
   */
  modelConfig: ModelConfigInfo | null
  /**
   * True iff `session/set_config_option` is responsive. False on agents
   * like gemini that return ACP `-32601` ("method not found").
   */
  supportsConfigOption: boolean

  /**
   * Populated when the probe couldn't complete cleanly. The other fields
   * are best-effort partial values in that case — callers should check
   * `error` first.
   */
  error?: ProbeError

  /**
   * Raw initialize + session/new responses. Lets callers extract any
   * `_meta` or unknown fields the schema didn't surface.
   */
  raw: {
    initialize: unknown
    newSession: unknown | null
  }
}
