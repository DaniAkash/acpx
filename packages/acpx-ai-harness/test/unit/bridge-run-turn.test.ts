import { describe, expect, test } from 'bun:test'
import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import type { BridgeTurn } from '@ai-sdk/harness/bridge'
import { acpEvent, acpResult, MockAcpRuntime } from 'acpx-test-helpers'
import type { AcpxBridgeStartMessage } from '../../src/acpx-bridge-protocol.ts'
import { runAcpxTurn } from '../../src/bridge/run-turn.ts'

function makeFakeBridgeTurn(): {
  turn: BridgeTurn
  emitted: HarnessV1StreamPart[]
  abort: () => void
} {
  const emitted: HarnessV1StreamPart[] = []
  const controller = new AbortController()
  const turn: BridgeTurn = {
    emit: (event) => {
      emitted.push(event as HarnessV1StreamPart)
    },
    requestToolResult: async () => ({ output: null }),
    requestToolApproval: async () => ({ approved: true }),
    pendingUserMessages: [],
    abortSignal: controller.signal,
    firstTurn: true,
    bridgeLog: () => {},
    emitWarning: () => {},
    emitError: () => {},
  }
  return { turn, emitted, abort: () => controller.abort() }
}

const baseStart = (
  overrides: Partial<AcpxBridgeStartMessage> = {},
): AcpxBridgeStartMessage => ({
  type: 'start',
  prompt: 'hello',
  agent: 'claude',
  sessionKey: 'sess-1',
  cwd: '/tmp/bridge-work',
  ...overrides,
})

describe('runAcpxTurn — start frame validation', () => {
  test('rejects a frame missing required acpx fields', async () => {
    const { turn } = makeFakeBridgeTurn()
    const bad = {
      type: 'start',
      prompt: 'hi',
      agent: 'claude',
    } as unknown as AcpxBridgeStartMessage
    await expect(
      runAcpxTurn(bad, turn, { workdir: '/tmp/x' }),
    ).rejects.toThrow()
  })
})

describe('runAcpxTurn — happy path (text-only turn against MockAcpRuntime)', () => {
  test('emits stream-start, text deltas, and a clean finish', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [acpEvent.text('hel'), acpEvent.text('lo')],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const { turn, emitted } = makeFakeBridgeTurn()
    await runAcpxTurn(baseStart(), turn, {
      workdir: '/tmp/bridge-work',
      runtime,
    })
    const types = emitted.map((p) => p.type)
    expect(types[0]).toBe('stream-start')
    expect(types).toContain('text-start')
    expect(types).toContain('text-delta')
    expect(types).toContain('text-end')
    expect(types.at(-1)).toBe('finish')
    const finish = emitted.find((p) => p.type === 'finish') as Extract<
      HarnessV1StreamPart,
      { type: 'finish' }
    >
    expect(finish.finishReason.unified).toBe('stop')
  })

  test('thread the model option to the acpx session via sessionOptions', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [acpEvent.text('ok')],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const { turn } = makeFakeBridgeTurn()
    await runAcpxTurn(baseStart({ model: 'claude-opus-4-7' }), turn, {
      workdir: '/tmp/bridge-work',
      runtime,
    })
    const ensure = runtime.ensureSessionCalls[0]
    expect(ensure?.sessionOptions).toEqual({ model: 'claude-opus-4-7' })
  })

  test('forwards the bridge abort signal to acpx.startTurn', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [acpEvent.text('x')],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const { turn } = makeFakeBridgeTurn()
    await runAcpxTurn(baseStart(), turn, {
      workdir: '/tmp/bridge-work',
      runtime,
    })
    const startTurnCall = runtime.startTurnCalls[0]
    expect(startTurnCall?.signal).toBeDefined()
  })
})

describe('runAcpxTurn — host tools deferral', () => {
  test('emits an unsupported-tool warning per host AI SDK tool on stream-start', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [acpEvent.text('hi')],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const { turn, emitted } = makeFakeBridgeTurn()
    await runAcpxTurn(
      baseStart({
        tools: [
          { name: 'getWeather', description: 'weather lookup' },
          { name: 'sendEmail', description: 'compose mail' },
        ],
      }),
      turn,
      { workdir: '/tmp/bridge-work', runtime },
    )
    const streamStart = emitted.find(
      (p) => p.type === 'stream-start',
    ) as Extract<HarnessV1StreamPart, { type: 'stream-start' }>
    expect(streamStart.warnings).toHaveLength(2)
    expect(streamStart.warnings?.[0]).toMatchObject({
      type: 'unsupported-tool',
      tool: 'getWeather',
    })
    expect(streamStart.warnings?.[1]).toMatchObject({
      type: 'unsupported-tool',
      tool: 'sendEmail',
    })
  })
})

describe('runAcpxTurn — failure paths', () => {
  test('a failed acpx turn surfaces as error + finish', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [],
          result: acpResult.failed({
            message: 'auth',
            code: 'unauthenticated',
          }),
        },
      ],
    })
    const { turn, emitted } = makeFakeBridgeTurn()
    await runAcpxTurn(baseStart(), turn, {
      workdir: '/tmp/bridge-work',
      runtime,
    })
    const types = emitted.map((p) => p.type)
    expect(types).toContain('error')
    const finish = emitted.find((p) => p.type === 'finish') as Extract<
      HarnessV1StreamPart,
      { type: 'finish' }
    >
    expect(finish.finishReason.unified).toBe('error')
  })

  test('a thrown ensureSession surfaces a synthesised error + failed finish', async () => {
    const runtime = new MockAcpRuntime({
      ensureSessionError: new Error('agent_not_found'),
    })
    const { turn, emitted } = makeFakeBridgeTurn()
    await expect(
      runAcpxTurn(baseStart(), turn, {
        workdir: '/tmp/bridge-work',
        runtime,
      }),
    ).rejects.toThrow(/agent_not_found/)
    // ensureSession throws BEFORE the translator starts, so the bridge driver
    // bubbles the error to runBridge for emission rather than emitting it
    // itself.
    expect(emitted).toEqual([])
  })

  test('watchdog force-finishes when the agent emits error then goes silent', async () => {
    // A turn whose iterator yields an error event and then yields no
    // more events (and never resolves `result`). Without the watchdog
    // the host would hang forever; with it the bridge force-finishes
    // after the configured timeout.
    const neverSettles = new Promise<never>(() => {})
    const iter: AsyncIterator<unknown> = {
      async next() {
        if (!emitted) {
          emitted = true
          return {
            value: acpEvent.error('agent reported an error', {
              code: 'agent_err',
            }),
            done: false,
          }
        }
        return neverSettles
      },
      async return() {
        return { value: undefined, done: true }
      },
    }
    let emitted = false
    const fakeTurn = {
      requestId: 'req-watchdog',
      events: { [Symbol.asyncIterator]: () => iter },
      result: neverSettles,
      cancel: async () => {},
      closeStream: async () => {},
    }
    const runtime = {
      ensureSession: async () => ({
        sessionKey: 'k',
        backend: 'mock',
        runtimeSessionName: 'n',
      }),
      startTurn: () => fakeTurn,
      runTurn: () => fakeTurn.events,
    } as never
    const { turn, emitted: emittedParts } = makeFakeBridgeTurn()
    await runAcpxTurn(baseStart(), turn, {
      workdir: '/tmp/bridge-work',
      runtime,
      silentAfterErrorTimeoutMs: 100,
    })
    const types = emittedParts.map((p) => p.type)
    expect(types).toContain('error')
    const finish = emittedParts.find((p) => p.type === 'finish') as Extract<
      HarnessV1StreamPart,
      { type: 'finish' }
    >
    expect(finish.finishReason.unified).toBe('error')
  }, 10_000)
})
