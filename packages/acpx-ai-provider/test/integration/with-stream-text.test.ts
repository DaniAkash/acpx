import { describe, expect, test } from 'bun:test'
import { acpEvent, acpResult, MockAcpRuntime } from 'acpx-test-helpers'
import { isStepCount, streamText } from 'ai'
import { createAcpxProvider } from '../../src/index.ts'

describe('streamText — text-only turn', () => {
  test('result.text resolves to concatenated deltas', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [acpEvent.text('hel'), acpEvent.text('lo')],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({ agent: 'claude', runtime })

    const result = streamText({
      model: provider.languageModel(),
      prompt: 'say hi',
      stopWhen: isStepCount(1),
    })
    expect(await result.text).toBe('hello')
  })

  test('finishReason resolves to "stop" for end_turn', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [acpEvent.text('ok')],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({ agent: 'claude', runtime })

    const result = streamText({
      model: provider.languageModel(),
      prompt: 'hi',
      stopWhen: isStepCount(1),
    })
    expect(await result.finishReason).toBe('stop')
  })

  test('contextWindow surfaces on providerMetadata when usage_update arrives', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [acpEvent.text('hi'), acpEvent.usage(75, 4096)],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({ agent: 'claude', runtime })

    const result = streamText({
      model: provider.languageModel(),
      prompt: 'hi',
      stopWhen: isStepCount(1),
    })
    await result.finishReason
    const meta = (await result.providerMetadata) as
      | { acpx?: { contextWindow?: number } }
      | undefined
    expect(meta?.acpx?.contextWindow).toBe(4096)
  })

  test('textStream yields the same content', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [acpEvent.text('a'), acpEvent.text('b'), acpEvent.text('c')],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({ agent: 'claude', runtime })

    const result = streamText({
      model: provider.languageModel(),
      prompt: 'hi',
      stopWhen: isStepCount(1),
    })
    let acc = ''
    for await (const chunk of result.textStream) acc += chunk
    expect(acc).toBe('abc')
  })
})

describe('streamText — tool-call turn', () => {
  test('finishReason is tool-calls when stopReason is tool_calls', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [
            acpEvent.toolCall({
              toolCallId: 'c1',
              title: 'greet',
              text: '{"name":"world"}',
              status: 'completed',
            }),
          ],
          result: acpResult.completed('tool_calls'),
        },
      ],
    })
    const provider = createAcpxProvider({ agent: 'claude', runtime })

    const result = streamText({
      model: provider.languageModel(),
      prompt: 'greet world',
      stopWhen: isStepCount(1),
    })
    expect(await result.finishReason).toBe('tool-calls')
  })
})

describe('streamText — failure', () => {
  test('failed turn surfaces as finishReason "error"', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [],
          result: acpResult.failed({ message: 'boom', code: 'rate' }),
        },
      ],
    })
    const provider = createAcpxProvider({ agent: 'claude', runtime })

    const result = streamText({
      model: provider.languageModel(),
      prompt: 'hi',
      stopWhen: isStepCount(1),
      onError: () => {},
    })
    expect(await result.finishReason).toBe('error')
  })
})

describe('streamText — fullStream shape', () => {
  test('emits text-start / text-delta / text-end / finish-step / finish', async () => {
    const runtime = new MockAcpRuntime({
      turnScripts: [
        {
          events: [acpEvent.text('hi')],
          result: acpResult.completed('end_turn'),
        },
      ],
    })
    const provider = createAcpxProvider({ agent: 'claude', runtime })

    const result = streamText({
      model: provider.languageModel(),
      prompt: 'hi',
      stopWhen: isStepCount(1),
    })
    const types: string[] = []
    // ai@7.0.0-beta.116 still uses `fullStream`. The migration guide
    // notes the rename to `stream` is coming, but it has only landed
    // on canary so far (canary.156+). Switch to `result.stream` once
    // the rename ships in a beta release.
    for await (const part of result.fullStream) types.push(part.type)
    expect(types).toContain('text-start')
    expect(types).toContain('text-delta')
    expect(types).toContain('text-end')
    expect(types).toContain('finish')
  })
})
