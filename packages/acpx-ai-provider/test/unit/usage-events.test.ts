import { describe, expect, test } from 'bun:test'
import { acpEvent, acpResult, MockAcpRuntime } from 'acpx-test-helpers'
import { createAcpxProvider } from '../../src/index.ts'

const userPrompt = [
  { role: 'user', content: [{ type: 'text', text: 'hi' }] },
] as const

describe('AcpxProvider — usage event subscription', () => {
  test('emits usage events on provider.events.on("usage") with cost + breakdown', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [
            acpEvent.text('hi'),
            acpEvent.usage(1200, 200_000, {
              cost: { amount: 0.0123, currency: 'USD' },
              breakdown: {
                inputTokens: 800,
                outputTokens: 400,
                cachedReadTokens: 600,
                cachedWriteTokens: 50,
                thoughtTokens: 75,
                totalTokens: 1925,
              },
            }),
          ],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 'test-session',
      runtime,
    })

    const observed: unknown[] = []
    provider.events.on('usage', (snapshot) => observed.push(snapshot))

    const { stream } = await provider.languageModel().doStream({
      prompt: userPrompt as never,
    })
    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    expect(observed).toHaveLength(1)
    const snapshot = observed[0] as Record<string, unknown>
    expect(snapshot.used).toBe(1200)
    expect(snapshot.size).toBe(200_000)
    expect(snapshot.cost).toEqual({ amount: 0.0123, currency: 'USD' })
    expect(snapshot.breakdown).toMatchObject({
      inputTokens: 800,
      outputTokens: 400,
      cachedReadTokens: 600,
      cachedWriteTokens: 50,
      thoughtTokens: 75,
      totalTokens: 1925,
    })
    expect(snapshot.sessionKey).toBe('test-session')
    expect(typeof snapshot.at).toBe('number')
  })

  test('provider.getUsage() returns the most recent snapshot synchronously', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [
            acpEvent.usage(50, 1000),
            acpEvent.usage(75, 1000),
            acpEvent.usage(100, 1000),
          ],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 'test-session',
      runtime,
    })

    expect(provider.getUsage('test-session')).toBeUndefined()

    const { stream } = await provider.languageModel().doStream({
      prompt: userPrompt as never,
    })
    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    const snapshot = provider.getUsage('test-session')
    expect(snapshot?.used).toBe(100)
    expect(snapshot?.size).toBe(1000)
  })
})

describe('AcpxProvider — available commands event subscription', () => {
  test('emits availableCommands events with the full structured list', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [
            acpEvent.availableCommands([
              {
                name: '/compact',
                description: 'Compact context',
                hasInput: false,
              },
              { name: '/clear', hasInput: false },
              { name: '/cost', description: 'Show cost', hasInput: false },
            ]),
            acpEvent.text('done'),
          ],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 'test-session',
      runtime,
    })

    const observed: unknown[] = []
    provider.events.on('availableCommands', (payload) => observed.push(payload))

    const { stream } = await provider.languageModel().doStream({
      prompt: userPrompt as never,
    })
    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    expect(observed).toHaveLength(1)
    const event = observed[0] as { sessionKey: string; commands: unknown[] }
    expect(event.sessionKey).toBe('test-session')
    expect(event.commands).toHaveLength(3)
    expect(provider.getAvailableCommands('test-session')).toHaveLength(3)
  })
})

describe('AcpxProvider — runSlashCommand', () => {
  test('starts a turn with the slash name as text and drains the iterator', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 'test-session',
      runtime,
    })

    await provider.runSlashCommand({ name: '/compact' })
    const call = runtime.startTurnCalls.at(-1)
    expect(call?.text).toBe('/compact')
  })

  test('routes usage_update fired during the turn to provider.events (e.g. post-compaction)', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [
            acpEvent.usage(500, 200_000, {
              breakdown: {
                inputTokens: 300,
                outputTokens: 200,
                totalTokens: 500,
              },
            }),
          ],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 'test-session',
      runtime,
    })

    const observed: unknown[] = []
    provider.events.on('usage', (snapshot) => observed.push(snapshot))

    await provider.runSlashCommand({ name: '/compact' })

    expect(observed).toHaveLength(1)
    expect((observed[0] as { used: number }).used).toBe(500)
    // The synchronous read reflects it too.
    expect(provider.getUsage('test-session')?.used).toBe(500)
  })

  test('throws an AcpxError-ish error if the slash command turn fails', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [],
          result: acpResult.failed({ message: 'no such command' }),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 'test-session',
      runtime,
    })

    await expect(provider.runSlashCommand({ name: '/bogus' })).rejects.toThrow(
      /slash command "\/bogus" failed: no such command/,
    )
  })
})

describe('AcpxProvider — compact', () => {
  test('throws when no compact command has been advertised', async () => {
    const runtime = new MockAcpRuntime()
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 'test-session',
      runtime,
    })

    await expect(provider.compact()).rejects.toThrow(
      /does not advertise a compact command/,
    )
  })

  test('sends the advertised compact name as a slash-command turn', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [
            acpEvent.availableCommands([
              {
                name: '/compact',
                description: 'Compact context',
                hasInput: false,
              },
            ]),
          ],
          result: acpResult.completed('end_turn'),
        },
        {
          events: [],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 'test-session',
      runtime,
    })

    // First turn: any prompt; surfaces the availableCommands list to the
    // provider via the event subscription.
    const { stream } = await provider.languageModel().doStream({
      prompt: userPrompt as never,
    })
    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    await provider.compact()
    expect(runtime.startTurnCalls.at(-1)?.text).toBe('/compact')
  })

  test('matches /condense as a compact-equivalent name', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [
            acpEvent.availableCommands([
              { name: '/condense', description: 'Condense', hasInput: false },
            ]),
          ],
          result: acpResult.completed('end_turn'),
        },
        {
          events: [],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 'cond-session',
      runtime,
    })

    const { stream } = await provider.languageModel().doStream({
      prompt: userPrompt as never,
    })
    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    await provider.compact()
    expect(runtime.startTurnCalls.at(-1)?.text).toBe('/condense')
  })

  test('adds a leading slash when the advertised name has none', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [
            acpEvent.availableCommands([
              { name: 'compact', description: 'Compact', hasInput: false },
            ]),
          ],
          result: acpResult.completed('end_turn'),
        },
        {
          events: [],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 'no-slash-session',
      runtime,
    })

    const { stream } = await provider.languageModel().doStream({
      prompt: userPrompt as never,
    })
    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    await provider.compact()
    expect(runtime.startTurnCalls.at(-1)?.text).toBe('/compact')
  })

  test('throws when only unrelated commands are advertised', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [
            acpEvent.availableCommands([
              { name: '/clear', description: 'Clear', hasInput: false },
              { name: '/cost', description: 'Cost', hasInput: false },
            ]),
          ],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 'unrelated-session',
      runtime,
    })

    const { stream } = await provider.languageModel().doStream({
      prompt: userPrompt as never,
    })
    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    await expect(provider.compact()).rejects.toThrow(
      /does not advertise a compact command/,
    )
  })
})

describe('AcpxProvider — multi-session isolation', () => {
  test('getUsage and getAvailableCommands keep per-sessionKey state separate', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [
            acpEvent.availableCommands([{ name: '/clear', hasInput: false }]),
            acpEvent.usage(100, 1000),
          ],
          result: acpResult.completed('end_turn'),
        },
        {
          events: [
            acpEvent.availableCommands([
              { name: '/compact', hasInput: false },
              { name: '/cost', hasInput: false },
            ]),
            acpEvent.usage(200, 2000),
          ],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      runtime,
    })

    // Drive a turn under sessionKey 'A'.
    const streamA = await provider
      .languageModel(undefined, {
        sessionKey: 'A',
      })
      .doStream({ prompt: userPrompt as never })
    const readerA = streamA.stream.getReader()
    while (true) {
      const { done } = await readerA.read()
      if (done) break
    }

    // Drive a turn under sessionKey 'B'.
    const streamB = await provider
      .languageModel(undefined, {
        sessionKey: 'B',
      })
      .doStream({ prompt: userPrompt as never })
    const readerB = streamB.stream.getReader()
    while (true) {
      const { done } = await readerB.read()
      if (done) break
    }

    // Usage state isolated.
    expect(provider.getUsage('A')?.used).toBe(100)
    expect(provider.getUsage('A')?.size).toBe(1000)
    expect(provider.getUsage('B')?.used).toBe(200)
    expect(provider.getUsage('B')?.size).toBe(2000)

    // Commands state isolated.
    expect(provider.getAvailableCommands('A').map((c) => c.name)).toEqual([
      '/clear',
    ])
    expect(provider.getAvailableCommands('B').map((c) => c.name)).toEqual([
      '/compact',
      '/cost',
    ])

    // Reading an unknown sessionKey returns empty/undefined.
    expect(provider.getUsage('does-not-exist')).toBeUndefined()
    expect(provider.getAvailableCommands('does-not-exist')).toEqual([])
  })
})

describe('AcpxProvider — default sessionKey resolution', () => {
  test('getUsage and getAvailableCommands without args fall through to resolveSessionKey({})', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [
            acpEvent.availableCommands([{ name: '/compact', hasInput: false }]),
            acpEvent.usage(42, 4096),
          ],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 'default-session',
      runtime,
    })

    const { stream } = await provider.languageModel().doStream({
      prompt: userPrompt as never,
    })
    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    // No sessionKey arg → uses settings.sessionKey.
    expect(provider.getUsage()?.used).toBe(42)
    expect(provider.getAvailableCommands().map((c) => c.name)).toEqual([
      '/compact',
    ])
  })

  test('default sessionKey falls back to "<agent>::<cwd>" when settings.sessionKey is unset', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [acpEvent.usage(7, 700)],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/fallback-cwd',
      runtime,
    })

    const { stream } = await provider.languageModel().doStream({
      prompt: userPrompt as never,
    })
    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    expect(provider.getUsage()?.used).toBe(7)
    expect(provider.getUsage('claude::/tmp/fallback-cwd')?.used).toBe(7)
  })
})

describe('AcpxProvider — EventEmitter contract', () => {
  test('multiple listeners on the same channel all receive every event', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [acpEvent.usage(1, 10), acpEvent.usage(2, 10)],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 's',
      runtime,
    })

    const a: number[] = []
    const b: number[] = []
    provider.events.on('usage', (s) => a.push(s.used ?? -1))
    provider.events.on('usage', (s) => b.push(s.used ?? -1))

    const { stream } = await provider.languageModel().doStream({
      prompt: userPrompt as never,
    })
    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    expect(a).toEqual([1, 2])
    expect(b).toEqual([1, 2])
  })

  test('events.off removes a listener so subsequent events do not reach it', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [acpEvent.usage(1, 10)],
          result: acpResult.completed('end_turn'),
        },
        {
          events: [acpEvent.usage(2, 10)],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 's',
      runtime,
    })

    const seen: number[] = []
    const listener = (s: { used?: number }) => seen.push(s.used ?? -1)
    provider.events.on('usage', listener)

    // First turn — listener fires.
    const s1 = await provider.languageModel().doStream({
      prompt: userPrompt as never,
    })
    const r1 = s1.stream.getReader()
    while (true) {
      const { done } = await r1.read()
      if (done) break
    }

    // Detach and run a second turn — listener does not fire again.
    provider.events.off('usage', listener)
    const s2 = await provider.languageModel().doStream({
      prompt: userPrompt as never,
    })
    const r2 = s2.stream.getReader()
    while (true) {
      const { done } = await r2.read()
      if (done) break
    }

    expect(seen).toEqual([1])
  })

  test('availableCommands event fires with empty list when the agent advertises zero commands', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [acpEvent.availableCommands([])],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 's',
      runtime,
    })

    const events: Array<{ commands: unknown[] }> = []
    provider.events.on('availableCommands', (e) => events.push(e))

    const { stream } = await provider.languageModel().doStream({
      prompt: userPrompt as never,
    })
    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    expect(events).toHaveLength(1)
    expect(events[0]?.commands).toEqual([])
    expect(provider.getAvailableCommands('s')).toEqual([])
  })

  test('multiple usage_update events in one turn fire the listener in order', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [
            acpEvent.usage(10, 100),
            acpEvent.usage(20, 100),
            acpEvent.usage(30, 100),
          ],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 's',
      runtime,
    })

    const used: number[] = []
    provider.events.on('usage', (s) => used.push(s.used ?? -1))

    const { stream } = await provider.languageModel().doStream({
      prompt: userPrompt as never,
    })
    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    expect(used).toEqual([10, 20, 30])
    // Latest snapshot wins on the sync getter.
    expect(provider.getUsage('s')?.used).toBe(30)
  })
})

describe('AcpxProvider — runSlashCommand option pass-through', () => {
  test('timeoutMs and signal thread through to runtime.startTurn', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 's',
      runtime,
    })

    const controller = new AbortController()
    await provider.runSlashCommand({
      name: '/status',
      timeoutMs: 12_345,
      signal: controller.signal,
    })

    const call = runtime.startTurnCalls.at(-1)
    expect(call?.text).toBe('/status')
    expect(call?.timeoutMs).toBe(12_345)
    expect(call?.signal).toBe(controller.signal)
  })

  test('agent override threads through to ensureHandle and startTurn', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({
      agent: 'claude',
      cwd: '/tmp/test',
      sessionKey: 's',
      runtime,
    })

    await provider.runSlashCommand({ name: '/status', agent: 'codex' })

    // ensureSession was called with the override agent.
    const ensure = runtime.ensureSessionCalls.at(-1)
    expect(ensure?.agent).toBe('codex')
  })
})
