import type {
  InitializeResponse,
  NewSessionResponse,
  SessionConfigOption as SdkConfigOption,
} from '@agentclientprotocol/sdk'
import type {
  AgentCapabilities,
  AgentInfo,
  AuthMethod,
  McpCapabilities,
  ModelConfigInfo,
  ProbedConfigOption,
  ProbedConfigOptionValue,
  ProbedMode,
  ProbedModel,
  PromptCapabilities,
  ReasoningInfo,
  SessionCapabilities,
} from '../types.ts'

export function normalizeAgentInfo(raw: InitializeResponse): AgentInfo | null {
  const info = raw.agentInfo
  if (!info) return null
  const name = typeof info.name === 'string' ? info.name : ''
  if (!name) return null
  return {
    name,
    ...(typeof info.title === 'string' ? { title: info.title } : {}),
    ...(typeof info.version === 'string' ? { version: info.version } : {}),
  }
}

export function normalizeCapabilities(
  raw: InitializeResponse,
): AgentCapabilities {
  const caps = raw.agentCapabilities ?? {}
  const promptCapabilities: PromptCapabilities = {
    image: Boolean(caps.promptCapabilities?.image),
    audio: Boolean(caps.promptCapabilities?.audio),
    embeddedContext: Boolean(caps.promptCapabilities?.embeddedContext),
  }
  const mcp = (caps.mcpCapabilities ?? {}) as Record<string, unknown>
  const { http, sse, _meta: _ignoredMeta, ...rest } = mcp
  const restEntries = Object.entries(rest)
  const mcpCapabilities: McpCapabilities = {
    http: Boolean(http),
    sse: Boolean(sse),
    ...(restEntries.length > 0
      ? { meta: Object.fromEntries(restEntries) }
      : {}),
  }
  const sess = caps.sessionCapabilities ?? {}
  const sessionCapabilities: SessionCapabilities = {
    close: sess.close != null,
    list: sess.list != null,
    resume: sess.resume != null,
    fork: sess.fork != null,
    additionalDirectories: sess.additionalDirectories != null,
  }
  const experimental: AgentCapabilities['experimental'] = {}
  if ('auth' in caps && caps.auth != null) experimental.auth = caps.auth
  if ('nes' in caps && caps.nes != null) experimental.nes = caps.nes
  if ('providers' in caps && caps.providers != null) {
    experimental.providers = caps.providers
  }
  if ('positionEncoding' in caps && caps.positionEncoding != null) {
    experimental.positionEncoding = caps.positionEncoding
  }
  return {
    loadSession: Boolean(caps.loadSession),
    promptCapabilities,
    mcpCapabilities,
    sessionCapabilities,
    ...(Object.keys(experimental).length > 0 ? { experimental } : {}),
  }
}

export function normalizeAuthMethods(raw: InitializeResponse): AuthMethod[] {
  const methods = raw.authMethods ?? []
  return methods.map((m) => {
    const record = m as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : ''
    const name = typeof record.name === 'string' ? record.name : id
    const description =
      typeof record.description === 'string' ? record.description : undefined
    const type = typeof record.type === 'string' ? record.type : undefined
    const vars = Array.isArray(record.vars)
      ? (record.vars as Array<{ name: unknown }>)
          .map((v) => (typeof v.name === 'string' ? { name: v.name } : null))
          .filter((v): v is { name: string } => v !== null)
      : undefined
    const meta = (record._meta ?? null) as Record<string, unknown> | null
    return {
      id,
      name,
      ...(description !== undefined ? { description } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(vars !== undefined ? { vars } : {}),
      ...(meta !== null && typeof meta === 'object' ? { meta } : {}),
    }
  })
}

/**
 * The models the agent's settable picker exposes. ACP 1.x removed the
 * separate declarative `session/new.models.availableModels` list, so the
 * model-selector config option is now the single source; its option ids
 * are exactly the values `setConfigOption` accepts.
 */
export function normalizeModels(
  configOptions: ProbedConfigOption[],
): ProbedModel[] {
  const opt = findModelOption(configOptions)
  if (!opt?.options) return []
  return opt.options.map((v) => ({
    id: v.value,
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.description !== undefined ? { description: v.description } : {}),
  }))
}

export function normalizeModes(raw: NewSessionResponse | null): ProbedMode[] {
  if (!raw?.modes) return []
  return raw.modes.availableModes.map((m) => ({
    id: m.id,
    ...(typeof m.name === 'string' ? { name: m.name } : {}),
    ...(typeof m.description === 'string'
      ? { description: m.description }
      : {}),
  }))
}

export function normalizeConfigOptions(
  raw: NewSessionResponse | null,
): ProbedConfigOption[] {
  const options = raw?.configOptions
  if (!options) return []
  return options.map(normalizeConfigOption)
}

function normalizeConfigOption(o: SdkConfigOption): ProbedConfigOption {
  const id = o.id
  const name = o.name
  const description =
    typeof o.description === 'string' ? o.description : undefined
  const category = typeof o.category === 'string' ? o.category : undefined
  if (o.type === 'select') {
    const values: ProbedConfigOptionValue[] = collectSelectValues(o.options)
    return {
      id,
      name,
      ...(description !== undefined ? { description } : {}),
      ...(category !== undefined ? { category } : {}),
      type: 'select',
      currentValue: o.currentValue,
      options: values,
    }
  }
  // boolean
  return {
    id,
    name,
    ...(description !== undefined ? { description } : {}),
    ...(category !== undefined ? { category } : {}),
    type: 'boolean',
    currentValue: o.currentValue,
  }
}

function collectSelectValues(options: unknown): ProbedConfigOptionValue[] {
  if (!Array.isArray(options)) return []
  const out: ProbedConfigOptionValue[] = []
  for (const entry of options) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    // SessionConfigSelectOption: { value, name, description? }
    if (typeof rec.value === 'string') {
      out.push({
        value: rec.value,
        ...(typeof rec.name === 'string' ? { name: rec.name } : {}),
        ...(typeof rec.description === 'string'
          ? { description: rec.description }
          : {}),
      })
      continue
    }
    // SessionConfigSelectGroup: { groupId, options: [...] } — flatten.
    if (Array.isArray(rec.options)) {
      out.push(...collectSelectValues(rec.options))
    }
  }
  return out
}

export function deriveReasoning(
  configOptions: ProbedConfigOption[],
): ReasoningInfo | null {
  const opt = configOptions.find(
    (o) => o.category === 'thought_level' && o.type === 'select',
  )
  if (!opt?.options) return null
  return {
    configId: opt.id,
    values: opt.options.map((v) => v.value),
    ...(typeof opt.currentValue === 'string'
      ? { defaultValue: opt.currentValue }
      : {}),
  }
}

/**
 * Find the settable model-selector config option. Agents identify it by
 * `id === 'model'` or by category (`'model'`, or ACP 1.x's `'model_config'`).
 */
function findModelOption(
  configOptions: ProbedConfigOption[],
): ProbedConfigOption | undefined {
  return configOptions.find(
    (o) =>
      o.type === 'select' &&
      (o.id === 'model' ||
        o.category === 'model' ||
        o.category === 'model_config'),
  )
}

export function deriveModelConfig(
  configOptions: ProbedConfigOption[],
): ModelConfigInfo | null {
  const opt = findModelOption(configOptions)
  if (!opt?.options) return null
  return {
    configId: opt.id,
    values: opt.options.map((v) => v.value),
    ...(typeof opt.currentValue === 'string'
      ? { currentValue: opt.currentValue }
      : {}),
  }
}
