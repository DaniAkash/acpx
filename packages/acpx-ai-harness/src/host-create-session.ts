import type {
  HarnessV1ContinueTurnOptions,
  HarnessV1ContinueTurnState,
  HarnessV1PromptControl,
  HarnessV1PromptTurnOptions,
  HarnessV1ResumeSessionState,
  HarnessV1Session,
} from '@ai-sdk/harness'
import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness'
import type { Experimental_SandboxProcess } from '@ai-sdk/provider-utils'
import type { AcpxBridgeStartMessage } from './acpx-bridge-protocol.ts'
import type { AcpxHarnessSettings } from './acpx-harness.ts'
import { requestStopPayload } from './host-detach.ts'
import { wirePromptControl } from './host-prompt-control.ts'
import { awaitProcExit, extractPromptText } from './host-session-utils.ts'
import type { AcpxChannel } from './sandbox-channel.ts'

export type RespawnStrategy = 'fresh' | 'attach' | 'rerun'

export interface BridgeCoordsLite {
  readonly port: number
  readonly token: string
  readonly sandboxId: string
}

export interface CreateSessionInput {
  readonly sessionId: string
  readonly sessionWorkDir: string
  readonly settings: AcpxHarnessSettings
  readonly agent: string
  readonly channel: AcpxChannel
  /**
   * Bridge process handle, or undefined when we ATTACH'd to a bridge
   * spawned by a previous process. On ATTACH the host doesn't own the
   * process lifecycle, so doDestroy / doStop send `destroy` / `stop`
   * frames and trust the bridge to exit.
   */
  readonly proc: Experimental_SandboxProcess | undefined
  readonly bridgeCoords: BridgeCoordsLite
  readonly isResume: boolean
  readonly respawnStrategy: RespawnStrategy
}

export function createSession(input: CreateSessionInput): HarnessV1Session {
  let stopped = false
  let instructionsApplied = false

  const assertLive = (method: string) => {
    if (stopped) {
      throw new Error(
        `acpx-ai-harness session ${input.sessionId} is already stopped; cannot call ${method}.`,
      )
    }
  }

  const baseStartFrame = (
    prompt: string,
    tools: HarnessV1PromptTurnOptions['tools'],
    extras: { continue?: boolean } = {},
  ): AcpxBridgeStartMessage => ({
    type: 'start',
    prompt,
    agent: input.agent,
    sessionKey: input.sessionId,
    cwd: input.sessionWorkDir,
    ...(input.settings.model ? { model: input.settings.model } : {}),
    ...(input.settings.stateDir ? { stateDir: input.settings.stateDir } : {}),
    ...(tools && tools.length > 0
      ? { tools: tools.map((t) => ({ ...t })) }
      : {}),
    ...(extras.continue ? { continue: true } : {}),
  })

  const doPromptTurn = (
    opts: HarnessV1PromptTurnOptions,
  ): Promise<HarnessV1PromptControl> => {
    assertLive('doPromptTurn')
    const prompt = extractPromptText(opts.prompt)
    const trimmedInstructions = opts.instructions?.trim() ?? ''
    const shouldApply = !instructionsApplied && trimmedInstructions.length > 0
    const text = shouldApply ? `${trimmedInstructions}\n\n${prompt}` : prompt
    if (shouldApply) instructionsApplied = true

    const control = wirePromptControl({
      channel: input.channel,
      emit: opts.emit,
      abortSignal: opts.abortSignal,
    })
    input.channel.send(baseStartFrame(text, opts.tools))
    return Promise.resolve(control)
  }

  const doContinueTurn = (
    opts: HarnessV1ContinueTurnOptions,
  ): Promise<HarnessV1PromptControl> => {
    assertLive('doContinueTurn')
    // doContinueTurn is only meaningful after doStart({ continueFrom }).
    // Fail fast if a consumer ever calls it on a fresh session — without
    // either an in-flight turn to attach to or a rerun nudge to send,
    // the returned `done` would hang forever.
    if (input.respawnStrategy === 'fresh') {
      return Promise.reject(
        new HarnessCapabilityUnsupportedError({
          harnessId: 'acpx',
          message:
            'acpx-ai-harness: doContinueTurn() requires a session created with `continueFrom`. ' +
            'Call doPromptTurn() on a fresh session instead.',
        }),
      )
    }
    const control = wirePromptControl({
      channel: input.channel,
      emit: opts.emit,
      abortSignal: opts.abortSignal,
    })
    // On ATTACH the bridge has the live turn buffering events past
    // lastSeenEventId; subscribing is enough. On RERUN the bridge is
    // fresh and there's no in-flight turn, so we send a small nudge
    // prompt that lets acpx pick up its persisted session and keep
    // going.
    if (input.respawnStrategy === 'rerun') {
      input.channel.send(
        baseStartFrame('Continue.', opts.tools, { continue: true }),
      )
    }
    return Promise.resolve(control)
  }

  const doDestroy = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    try {
      input.channel.beginClose()
      input.channel.send({ type: 'destroy' })
    } catch {
      /* socket may already be gone */
    }
    await awaitProcExit(input.proc)
    input.channel.close()
  }

  const buildBridgeState = (lastSeenEventId: number) => ({
    bridge: {
      port: input.bridgeCoords.port,
      token: input.bridgeCoords.token,
      sandboxId: input.bridgeCoords.sandboxId,
      lastSeenEventId,
    },
  })

  const suspendAndClose = async (): Promise<number> => {
    try {
      return await input.channel.suspend()
    } finally {
      try {
        input.channel.close()
      } catch {
        /* idempotent */
      }
    }
  }

  const doSuspendTurn = async (): Promise<HarnessV1ContinueTurnState> => {
    assertLive('doSuspendTurn')
    stopped = true
    const lastSeenEventId = await suspendAndClose()
    return {
      type: 'continue-turn',
      harnessId: 'acpx',
      specificationVersion: 'harness-v1',
      data: buildBridgeState(lastSeenEventId),
    }
  }

  const doDetach = async (): Promise<HarnessV1ResumeSessionState> => {
    assertLive('doDetach')
    stopped = true
    const lastSeenEventId = await suspendAndClose()
    return {
      type: 'resume-session',
      harnessId: 'acpx',
      specificationVersion: 'harness-v1',
      data: buildBridgeState(lastSeenEventId),
    }
  }

  const doStop = async (): Promise<HarnessV1ResumeSessionState> => {
    assertLive('doStop')
    stopped = true
    input.channel.beginClose()
    const stopData = await requestStopPayload(input.channel)
    await awaitProcExit(input.proc)
    input.channel.close()
    return {
      type: 'resume-session',
      harnessId: 'acpx',
      specificationVersion: 'harness-v1',
      data: stopData as HarnessV1ResumeSessionState['data'],
    }
  }

  return {
    sessionId: input.sessionId,
    isResume: input.isResume,
    doPromptTurn,
    doContinueTurn,
    doSuspendTurn,
    doDetach,
    doStop,
    doDestroy,
    doCompact: async () => {
      throw new HarnessCapabilityUnsupportedError({
        harnessId: 'acpx',
        message:
          'acpx-ai-harness: doCompact() is not supported. acpx runtimes auto-compact internally; manual compaction has no API.',
      })
    },
  }
}
