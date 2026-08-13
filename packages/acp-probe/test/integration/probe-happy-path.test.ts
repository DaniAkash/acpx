import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { probeAgent } from '../../src/index.ts'

const FAKE_AGENT = fileURLToPath(
  new URL('../helpers/fake-agent.ts', import.meta.url),
)
const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url))

function probeWithFake(
  agent: 'claude' | 'codex' | 'gemini',
  env: Record<string, string> = {},
): ReturnType<typeof probeAgent> {
  return probeAgent({
    argv: ['bun', 'run', FAKE_AGENT],
    env: {
      FAKE_INITIALIZE_FIXTURE: `${FIXTURES_DIR}${agent}-initialize.json`,
      FAKE_NEWSESSION_FIXTURE: `${FIXTURES_DIR}${agent}-newsession.json`,
      ...env,
    },
    timeoutMs: 10_000,
  })
}

describe('probeAgent — happy path against fake-agent driven by fixtures', () => {
  test('claude fixture round-trip surfaces models + effort reasoning', async () => {
    const result = await probeWithFake('claude')

    expect(result.error).toBeUndefined()
    expect(result.protocolVersion).toBe(1)
    expect(result.agentInfo?.name).toBe('@agentclientprotocol/claude-agent-acp')
    expect(result.capabilities.promptCapabilities).toEqual({
      image: true,
      audio: false,
      embeddedContext: true,
    })
    expect(result.models.map((m) => m.id)).toEqual([
      'default',
      'sonnet',
      'haiku',
    ])
    expect(result.reasoning).toEqual({
      configId: 'effort',
      values: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultValue: 'high',
    })
    expect(result.modelConfig).toEqual({
      configId: 'model',
      values: ['default', 'sonnet', 'haiku'],
      currentValue: 'default',
    })
    expect(result.supportsConfigOption).toBe(true)
    expect(result.agent.argv.length).toBeGreaterThan(0)
    expect(result.agent.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('codex fixture surfaces the 6 settable models and reasoning_effort id', async () => {
    const result = await probeWithFake('codex')

    expect(result.error).toBeUndefined()
    // ACP 1.x: models come from the model config option, so result.models
    // mirrors modelConfig.values (the 6 bare settable ids), not the old 24
    // fabricated `<model>/<effort>` compound ids.
    expect(result.models.length).toBe(6)
    expect(result.models.every((m) => !m.id.includes('/'))).toBe(true)
    expect(result.reasoning?.configId).toBe('reasoning_effort')
    expect(result.modelConfig?.values).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
      'gpt-5.2',
    ])
    expect(result.modelConfig?.currentValue).toBe('gpt-5.5')
    expect(result.authMethods.length).toBe(3)
  })

  test('gemini fixture surfaces audio=true, configOptions=[], reasoning=null', async () => {
    const result = await probeWithFake('gemini', {
      // gemini fixture has no configOptions; we still set ok so the
      // ping path is skipped (configOptions.length === 0 short-circuit).
      FAKE_SETCONFIG_BEHAVIOR: 'method_not_found',
    })

    expect(result.error).toBeUndefined()
    expect(result.capabilities.promptCapabilities.audio).toBe(true)
    expect(result.configOptions).toEqual([])
    expect(result.reasoning).toBeNull()
    expect(result.modelConfig).toBeNull()
    expect(result.supportsConfigOption).toBe(false)
  })
})

describe('probeAgent — supportsConfigOption detection', () => {
  test('-32601 on set_config_option flips supportsConfigOption to false', async () => {
    // Use the claude fixture (has configOptions) but make the fake agent
    // refuse set_config_option.
    const result = await probeWithFake('claude', {
      FAKE_SETCONFIG_BEHAVIOR: 'method_not_found',
    })
    expect(result.error).toBeUndefined()
    expect(result.configOptions.length).toBeGreaterThan(0)
    expect(result.supportsConfigOption).toBe(false)
  })
})
