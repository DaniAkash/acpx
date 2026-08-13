import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  type Client,
  ClientSideConnection,
  type InitializeResponse,
  type NewSessionResponse,
  ndJsonStream,
  RequestError,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk'
import {
  deriveModelConfig,
  deriveReasoning,
  normalizeAgentInfo,
  normalizeAuthMethods,
  normalizeCapabilities,
  normalizeConfigOptions,
  normalizeModels,
  normalizeModes,
} from './_internal/normalize.ts'
import { resolveAgentCommandFromId, splitArgv } from './resolve-command.ts'
import type {
  AgentProbeRequest,
  AgentProbeResult,
  ProbeError,
  ProbeErrorCode,
} from './types.ts'

const DEFAULT_TIMEOUT_MS = 30_000
const STDERR_CAP_BYTES = 8 * 1024
const ACP_METHOD_NOT_FOUND = -32601

/**
 * Probe an ACP-compatible agent for its capabilities. Performs an
 * `initialize` + `session/new` handshake (and optionally a no-op
 * `session/set_config_option` ping to detect `-32601`), then tears the
 * agent down. No real prompt is sent, so no LLM tokens are consumed.
 */
export async function probeAgent(
  request: AgentProbeRequest,
): Promise<AgentProbeResult> {
  const probedAt = new Date().toISOString()
  const startedNs = process.hrtime.bigint()
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const { agentId, argv } = await resolveArgv(request)
  const command = argv.join(' ')

  const baseResult = (): AgentProbeResult => ({
    agent: {
      id: agentId,
      command,
      argv,
      probedAt,
      durationMs: durationSince(startedNs),
    },
    protocolVersion: 0,
    agentInfo: null,
    capabilities: emptyCapabilities(),
    authMethods: [],
    models: [],
    modes: [],
    configOptions: [],
    reasoning: null,
    modelConfig: null,
    supportsConfigOption: false,
    raw: { initialize: null, newSession: null },
  })

  let child: ChildProcessByStdio<Writable, Readable, Readable> | null = null
  let stderrBuf = ''
  let initialize: InitializeResponse | null = null
  let newSession: NewSessionResponse | null = null

  const fail = (error: ProbeError): AgentProbeResult => ({
    ...baseResult(),
    agent: { ...baseResult().agent, durationMs: durationSince(startedNs) },
    error,
    raw: { initialize, newSession },
  })

  try {
    child = spawnAgent(argv, request)
  } catch (err) {
    return fail({
      code: 'spawn_failed',
      message: err instanceof Error ? err.message : String(err),
    })
  }
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBuf.length < STDERR_CAP_BYTES) {
      stderrBuf += chunk.toString('utf8')
      if (stderrBuf.length > STDERR_CAP_BYTES) {
        stderrBuf = stderrBuf.slice(0, STDERR_CAP_BYTES)
      }
    }
  })

  // Capture spawn ENOENT / EACCES asynchronously (Node's spawn fails
  // its sync return but raises 'error' on the child later).
  const spawnError: { value: Error | null } = { value: null }
  child.once('error', (err) => {
    spawnError.value = err
  })

  // Track unexpected child death — surfaces as agent_crashed if it
  // happens before we've completed initialize/session/new AND wasn't
  // triggered by our own killChild() (in which case `killedByUs` is
  // set first).
  const childExited: {
    value: { code: number | null; signal: NodeJS.Signals | null } | null
  } = { value: null }
  const killedByUs = { value: false }
  child.once('exit', (code, signal) => {
    childExited.value = { code, signal }
  })

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  )
  const connection = new ClientSideConnection(() => createProbeClient(), stream)

  const timeBudget = new TimeBudget(timeoutMs)

  // --- initialize ---
  try {
    initialize = await withDeadline(
      connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
        clientInfo: { name: 'acp-probe', version: '0.0.1' },
      }),
      timeBudget.remaining(),
    )
  } catch (err) {
    // Let pending 'error'/'exit' events drain before classifying. The
    // SDK call can reject (closed stream / EPIPE) racily a tick before
    // the spawn 'error' or child 'exit' event fires.
    await drainPendingEvents()
    if (spawnError.value) {
      await killChild(child, killedByUs)
      return fail({
        code: 'spawn_failed',
        message: spawnError.value.message,
        stderr: stderrBuf || undefined,
      })
    }
    if (err instanceof TimeoutError) {
      await killChild(child, killedByUs)
      return fail({
        code: 'initialize_timeout',
        message: err.message,
        stderr: stderrBuf || undefined,
      })
    }
    if (
      childExited.value &&
      !killedByUs.value &&
      childExited.value.code !== 0
    ) {
      await killChild(child, killedByUs)
      return fail({
        code: 'agent_crashed',
        message: `Agent exited (code=${childExited.value.code ?? null}, signal=${childExited.value.signal ?? null}) before responding to initialize`,
        stderr: stderrBuf || undefined,
      })
    }
    await killChild(child, killedByUs)
    return fail(classifyError(err, 'unknown', stderrBuf))
  }

  if (initialize.protocolVersion !== 1) {
    await killChild(child, killedByUs)
    return fail({
      code: 'protocol_mismatch',
      message: `Agent advertised protocol version ${initialize.protocolVersion}; this probe supports 1.`,
      stderr: stderrBuf || undefined,
    })
  }

  // --- session/new ---
  const authMethods = normalizeAuthMethods(initialize)
  if (authMethods.length > 0 && request.authPolicy === 'fail') {
    await killChild(child, killedByUs)
    return {
      ...baseResult(),
      agent: { ...baseResult().agent, durationMs: durationSince(startedNs) },
      protocolVersion: initialize.protocolVersion,
      agentInfo: normalizeAgentInfo(initialize),
      capabilities: normalizeCapabilities(initialize),
      authMethods,
      error: {
        code: 'auth_required',
        message: `Agent advertised authMethods (${authMethods.length}) and authPolicy is 'fail'.`,
      },
      raw: { initialize, newSession: null },
    }
  }

  try {
    newSession = await withDeadline(
      connection.newSession({
        cwd: request.cwd ?? process.cwd(),
        mcpServers: [],
      }),
      timeBudget.remaining(),
    )
  } catch (err) {
    await drainPendingEvents()
    if (err instanceof TimeoutError) {
      await killChild(child, killedByUs)
      return fail({
        code: 'session_new_timeout',
        message: err.message,
        stderr: stderrBuf || undefined,
      })
    }
    if (
      childExited.value &&
      !killedByUs.value &&
      childExited.value.code !== 0
    ) {
      await killChild(child, killedByUs)
      return fail({
        code: 'agent_crashed',
        message: `Agent exited (code=${childExited.value.code ?? null}, signal=${childExited.value.signal ?? null}) during session/new`,
        stderr: stderrBuf || undefined,
      })
    }
    await killChild(child, killedByUs)
    return fail(classifyError(err, 'unknown', stderrBuf))
  }

  // --- supportsConfigOption ping ---
  const configOptions = normalizeConfigOptions(newSession)
  let supportsConfigOption = false
  if (configOptions.length > 0) {
    const first = configOptions[0]!
    if (first.type === 'select' && typeof first.currentValue === 'string') {
      try {
        await withDeadline(
          connection.setSessionConfigOption({
            sessionId: newSession.sessionId,
            configId: first.id,
            value: first.currentValue,
          }),
          Math.min(5_000, timeBudget.remaining()),
        )
        supportsConfigOption = true
      } catch (err) {
        if (err instanceof RequestError && err.code === ACP_METHOD_NOT_FOUND) {
          supportsConfigOption = false
        } else {
          // Other errors are treated as "unsupported" conservatively —
          // they shouldn't fail the whole probe.
          supportsConfigOption = false
        }
      }
    }
  }

  // --- tear down ---
  await closeSession(connection, newSession.sessionId, initialize)
  await killChild(child, killedByUs)

  const capabilities = normalizeCapabilities(initialize)
  const models = normalizeModels(configOptions)
  const modes = normalizeModes(newSession)
  const reasoning = deriveReasoning(configOptions)
  const modelConfig = deriveModelConfig(configOptions)

  return {
    agent: {
      id: agentId,
      command,
      argv,
      probedAt,
      durationMs: durationSince(startedNs),
    },
    protocolVersion: initialize.protocolVersion,
    agentInfo: normalizeAgentInfo(initialize),
    capabilities,
    authMethods,
    models,
    modes,
    configOptions,
    reasoning,
    modelConfig,
    supportsConfigOption,
    raw: { initialize, newSession },
  }
}

async function resolveArgv(
  request: AgentProbeRequest,
): Promise<{ agentId: string | null; argv: string[] }> {
  if (request.argv && request.argv.length > 0) {
    return { agentId: null, argv: [...request.argv] }
  }
  if (request.command) {
    return { agentId: null, argv: splitArgv(request.command) }
  }
  if (request.agent) {
    const argv = await resolveAgentCommandFromId(request.agent)
    return { agentId: request.agent, argv }
  }
  throw new Error(
    'probeAgent: provide exactly one of { agent }, { command }, or { argv }.',
  )
}

function spawnAgent(
  argv: string[],
  request: AgentProbeRequest,
): ChildProcessByStdio<Writable, Readable, Readable> {
  const [command, ...args] = argv
  if (!command) {
    throw new Error('probeAgent: empty argv after resolution.')
  }
  return spawn(command, args, {
    cwd: request.cwd ?? process.cwd(),
    env: { ...process.env, ...(request.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

async function killChild(
  child: ChildProcessByStdio<Writable, Readable, Readable>,
  killedByUs: { value: boolean },
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  killedByUs.value = true
  child.kill('SIGTERM')
  // Best-effort 1s grace, then SIGKILL.
  await new Promise<void>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      try {
        child.kill('SIGKILL')
      } catch {
        /* already dead */
      }
      resolve()
    }, 1_000)
    child.once('exit', onExit)
  })
}

async function closeSession(
  connection: ClientSideConnection,
  sessionId: string,
  initialize: InitializeResponse,
): Promise<void> {
  if (!initialize.agentCapabilities?.sessionCapabilities?.close) return
  try {
    await withDeadline(connection.closeSession({ sessionId } as never), 3_000)
  } catch {
    // Best-effort close. We're about to kill the process anyway.
  }
}

function createProbeClient(): Client {
  return {
    async requestPermission(): Promise<RequestPermissionResponse> {
      // The probe never sends a real session/prompt, so this branch
      // shouldn't fire. Deny defensively if an agent emits a request
      // out-of-band.
      return { outcome: { outcome: 'cancelled' } } as RequestPermissionResponse
    },
    async sessionUpdate(): Promise<void> {
      // Probe is non-interactive; updates are ignored.
    },
  }
}

class TimeBudget {
  private readonly deadline: number
  constructor(totalMs: number) {
    this.deadline = Date.now() + totalMs
  }
  remaining(): number {
    return Math.max(0, this.deadline - Date.now())
  }
}

async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) {
    return Promise.race([
      p,
      Promise.reject(new TimeoutError(`deadline (${ms}ms) already elapsed`)),
    ]) as Promise<T>
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new TimeoutError(`deadline (${ms}ms) exceeded`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

class TimeoutError extends Error {
  override name = 'TimeoutError'
}

/**
 * Yield to the event loop a handful of times so any pending
 * 'error'/'exit' notifications on the child process can be observed.
 * The SDK call can reject (closed stream / EPIPE) racily a tick before
 * Node emits the corresponding child event.
 */
async function drainPendingEvents(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function classifyError(
  err: unknown,
  timeoutCode: ProbeErrorCode,
  stderr: string,
): ProbeError {
  if (err instanceof TimeoutError) {
    return {
      code: timeoutCode,
      message: err.message,
      stderr: stderr || undefined,
    }
  }
  if (err instanceof RequestError) {
    return {
      code: 'unknown',
      message: err.message,
      stderr: stderr || undefined,
      acpError: {
        code: err.code,
        message: err.message,
        data: err.data ?? undefined,
      },
    }
  }
  return {
    code: 'unknown',
    message: err instanceof Error ? err.message : String(err),
    stderr: stderr || undefined,
  }
}

function durationSince(startNs: bigint): number {
  return Number((process.hrtime.bigint() - startNs) / 1_000_000n)
}

function emptyCapabilities(): AgentProbeResult['capabilities'] {
  return {
    loadSession: false,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    mcpCapabilities: { http: false, sse: false },
    sessionCapabilities: {
      close: false,
      list: false,
      resume: false,
      fork: false,
      additionalDirectories: false,
    },
  }
}
