import { describe, expect, test } from 'bun:test'
import type {
  HarnessV1ContinueTurnState,
  HarnessV1ResumeSessionState,
} from '@ai-sdk/harness'
import {
  type CreateSessionInput,
  createSession,
  type RespawnStrategy,
} from '../../src/host-create-session.ts'
import type { AcpxChannel } from '../../src/sandbox-channel.ts'

interface FakeChannel {
  channel: AcpxChannel
  sent: Array<{ type: string } & Record<string, unknown>>
  stopReply: (data: unknown) => void
  suspendValue: number
}

function makeFakeChannel(): FakeChannel {
  const sent: FakeChannel['sent'] = []
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  const ref: { stopReply?: (data: unknown) => void; suspendValue: number } = {
    suspendValue: 99,
  }
  let closed = false

  const channel = {
    on: (type: string, listener: (event: unknown) => void) => {
      const arr = listeners.get(type) ?? []
      arr.push(listener)
      listeners.set(type, arr)
      if (type === 'bridge-stop') {
        ref.stopReply = (data: unknown) => {
          listener({ type: 'bridge-stop', data })
        }
      }
      return () => {
        const a = listeners.get(type)
        if (a)
          listeners.set(
            type,
            a.filter((l) => l !== listener),
          )
      }
    },
    send: (msg: { type: string } & Record<string, unknown>) => {
      sent.push(msg)
    },
    beginClose: () => {},
    close: () => {
      closed = true
    },
    isClosed: () => closed,
    suspend: async () => ref.suspendValue,
    open: async () => {},
    onClose: () => {},
  } as unknown as AcpxChannel

  return {
    channel,
    sent,
    get stopReply() {
      return (
        ref.stopReply ??
        (() => {
          throw new Error('bridge-stop listener not registered')
        })
      )
    },
    get suspendValue() {
      return ref.suspendValue
    },
  }
}

function makeInput(
  overrides: Partial<CreateSessionInput> = {},
  fake: FakeChannel = makeFakeChannel(),
): CreateSessionInput & { fake: FakeChannel } {
  return {
    sessionId: 'sess-1',
    sessionWorkDir: '/tmp/work',
    settings: { agent: 'codex' },
    agent: 'codex',
    channel: fake.channel,
    proc: undefined,
    bridgeCoords: { port: 4001, token: 'tok', sandboxId: 'sbx-1' },
    isResume: false,
    respawnStrategy: 'fresh' as RespawnStrategy,
    ...overrides,
    fake,
  } as CreateSessionInput & { fake: FakeChannel }
}

describe('createSession.doSuspendTurn', () => {
  test('returns continue-turn state with the bridge coords + suspend cursor', async () => {
    const input = makeInput()
    const session = createSession(input)
    const state = await session.doSuspendTurn()
    expect(state.type).toBe('continue-turn')
    expect(state.harnessId).toBe('acpx')
    expect((state as HarnessV1ContinueTurnState).data).toEqual({
      bridge: {
        port: 4001,
        token: 'tok',
        sandboxId: 'sbx-1',
        lastSeenEventId: input.fake.suspendValue,
      },
    })
  })

  test('the session refuses subsequent methods after suspend', async () => {
    const session = createSession(makeInput())
    await session.doSuspendTurn()
    expect(() => session.doPromptTurn({ prompt: 'x', emit: () => {} })).toThrow(
      /already stopped/,
    )
  })

  test('closes the channel even when channel.suspend() throws', async () => {
    const fake = makeFakeChannel()
    // Replace suspend with a thrower to exercise the finally branch.
    const orig = fake.channel.suspend
    ;(fake.channel as { suspend: () => Promise<number> }).suspend =
      async () => {
        throw new Error('suspend failed')
      }
    const session = createSession(makeInput({}, fake))
    await expect(session.doSuspendTurn()).rejects.toThrow(/suspend failed/)
    expect(fake.channel.isClosed()).toBe(true)
    ;(fake.channel as { suspend: () => Promise<number> }).suspend = orig
  })

  test('closes the channel after a successful suspend', async () => {
    const fake = makeFakeChannel()
    const session = createSession(makeInput({}, fake))
    await session.doSuspendTurn()
    expect(fake.channel.isClosed()).toBe(true)
  })
})

describe('createSession.doDetach', () => {
  test('returns resume-session state with the bridge coords + suspend cursor', async () => {
    const input = makeInput()
    const session = createSession(input)
    const state = await session.doDetach()
    expect(state.type).toBe('resume-session')
    expect((state as HarnessV1ResumeSessionState).data).toEqual({
      bridge: {
        port: 4001,
        token: 'tok',
        sandboxId: 'sbx-1',
        lastSeenEventId: input.fake.suspendValue,
      },
    })
  })

  test('closes the channel after detach', async () => {
    const fake = makeFakeChannel()
    const session = createSession(makeInput({}, fake))
    await session.doDetach()
    expect(fake.channel.isClosed()).toBe(true)
  })
})

describe('createSession.doStop', () => {
  test('sends a stop frame and emits the bridge-supplied state', async () => {
    const fake = makeFakeChannel()
    const session = createSession(makeInput({}, fake))
    const stopP = session.doStop()
    // Allow the listener to register before delivering the reply.
    await new Promise((r) => setTimeout(r, 0))
    fake.stopReply({ acpxSessionKey: 'sess-1', lastSeenEventId: 99 })
    const state = await stopP
    expect(state.type).toBe('resume-session')
    expect(state.data).toEqual({
      acpxSessionKey: 'sess-1',
      lastSeenEventId: 99,
    })
    const stopFrame = fake.sent.find((m) => m.type === 'stop')
    expect(stopFrame).toBeDefined()
  })
})

describe('createSession.doContinueTurn', () => {
  test('on ATTACH: does not send a start frame, just wires the control', async () => {
    const fake = makeFakeChannel()
    const session = createSession(
      makeInput({ respawnStrategy: 'attach', isResume: true }, fake),
    )
    await session.doContinueTurn({ emit: () => {} })
    expect(fake.sent).toEqual([])
  })

  test('on RERUN: sends a nudge `Continue.` prompt with continue=true', async () => {
    const fake = makeFakeChannel()
    const session = createSession(
      makeInput({ respawnStrategy: 'rerun', isResume: true }, fake),
    )
    await session.doContinueTurn({ emit: () => {} })
    const frame = fake.sent.find((m) => m.type === 'start')
    expect(frame).toMatchObject({
      type: 'start',
      prompt: 'Continue.',
      agent: 'codex',
      sessionKey: 'sess-1',
      cwd: '/tmp/work',
      continue: true,
    })
  })

  test('on FRESH: rejects with a clear error rather than hanging forever', async () => {
    const session = createSession(
      makeInput({ respawnStrategy: 'fresh', isResume: false }),
    )
    await expect(session.doContinueTurn({ emit: () => {} })).rejects.toThrow(
      /requires a session created with `continueFrom`/i,
    )
  })
})

describe('createSession.doDestroy', () => {
  test('sends destroy and closes the channel even without a proc handle', async () => {
    const fake = makeFakeChannel()
    const session = createSession(makeInput({ proc: undefined }, fake))
    await session.doDestroy()
    const destroy = fake.sent.find((m) => m.type === 'destroy')
    expect(destroy).toBeDefined()
    expect(fake.channel.isClosed()).toBe(true)
  })

  test('is idempotent on repeated calls', async () => {
    const fake = makeFakeChannel()
    const session = createSession(makeInput({ proc: undefined }, fake))
    await session.doDestroy()
    await session.doDestroy()
    const destroyFrames = fake.sent.filter((m) => m.type === 'destroy')
    expect(destroyFrames).toHaveLength(1)
  })
})

describe('createSession.doCompact', () => {
  test('rejects with HarnessCapabilityUnsupportedError', async () => {
    const session = createSession(makeInput())
    await expect(session.doCompact()).rejects.toThrow(
      /doCompact.*not supported/i,
    )
  })
})

describe('createSession.isResume', () => {
  test('reflects the isResume flag passed in', () => {
    expect(createSession(makeInput({ isResume: false })).isResume).toBe(false)
    expect(createSession(makeInput({ isResume: true })).isResume).toBe(true)
  })
})
