import { describe, expect, mock, test } from 'bun:test'
import { AgentResolveError } from '../../src/errors.ts'
import {
  resolveAgentCommandFromId,
  splitArgv,
} from '../../src/resolve-command.ts'

// acpx 0.13's real agent registry depends on machine config and is empty (or
// its methods are absent) in a bare environment such as CI, so mock
// `acpx/runtime` to exercise the resolver deterministically everywhere. The
// stub also covers both `resolve()` return shapes: acpx 0.13 structured argv
// (string[]) and a legacy command string.
mock.module('acpx/runtime', () => ({
  createAgentRegistry: () => ({
    list: (): string[] => ['claude', 'legacy'],
    resolve: (id: string): string | string[] =>
      id === 'claude'
        ? ['npx', '-y', '@agentclientprotocol/claude-agent-acp']
        : 'my-agent --acp',
  }),
}))

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
  test('returns acpx structured argv (string[]) verbatim', async () => {
    const argv = await resolveAgentCommandFromId('claude')
    expect(argv).toEqual(['npx', '-y', '@agentclientprotocol/claude-agent-acp'])
  })

  test('shell-splits a legacy command string from resolve()', async () => {
    const argv = await resolveAgentCommandFromId('legacy')
    expect(argv).toEqual(['my-agent', '--acp'])
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
