import { describe, expect, test } from 'bun:test'
import { AgentResolveError } from '../../src/errors.ts'
import {
  resolveAgentCommandFromId,
  splitArgv,
} from '../../src/resolve-command.ts'

describe('splitArgv', () => {
  test('simple whitespace split', () => {
    expect(splitArgv('npx -y package')).toEqual(['npx', '-y', 'package'])
  })

  test('preserves quoted substrings', () => {
    expect(splitArgv('cmd "hello world" tail')).toEqual([
      'cmd',
      'hello world',
      'tail',
    ])
    expect(splitArgv("cmd 'no escapes \\n inside' tail")).toEqual([
      'cmd',
      'no escapes \\n inside',
      'tail',
    ])
  })

  test('honors backslash escapes outside single quotes', () => {
    expect(splitArgv('cmd a\\ b c')).toEqual(['cmd', 'a b', 'c'])
  })

  test('collapses multiple whitespace', () => {
    expect(splitArgv('a   b\tc\nd')).toEqual(['a', 'b', 'c', 'd'])
  })

  test('returns empty array for empty input', () => {
    expect(splitArgv('')).toEqual([])
  })
})

describe('resolveAgentCommandFromId', () => {
  test('returns argv for whatever agent id the installed acpx registers', async () => {
    // Which ids acpx knows depends on its version and environment config:
    // acpx 0.13's registry is empty in a bare environment (e.g. CI), so
    // resolve an id acpx actually reports rather than assuming 'claude'.
    const mod = (await import('acpx/runtime' as never)) as {
      createAgentRegistry: () => { list: () => readonly string[] }
    }
    const known = mod.createAgentRegistry().list()
    const first = known[0]
    if (!first) return
    const id = known.includes('claude') ? 'claude' : first
    const argv = await resolveAgentCommandFromId(id)
    expect(argv.length).toBeGreaterThan(0)
    if (id === 'claude') {
      expect(argv.some((a) => a.includes('claude'))).toBe(true)
    }
  })

  test('throws AgentResolveError with unknown_agent for a bogus id', async () => {
    let thrown: unknown = null
    try {
      await resolveAgentCommandFromId('definitely-not-an-agent-xyz123')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(AgentResolveError)
    expect((thrown as AgentResolveError).resolveCause).toBe('unknown_agent')
  })
})
