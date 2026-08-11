import { describe, expect, test } from 'bun:test'
import {
  isAgentSupported,
  listSupportedAgents,
  resolveAgentSkillsDir,
} from '../../src/index.ts'

describe('agent catalog', () => {
  // Locks the vendored catalog size so a silent upstream drift on the next
  // refresh is caught. Bump this when the vendored `skills` version changes.
  test('exposes the full vendored catalog', () => {
    expect(listSupportedAgents()).toHaveLength(76)
  })

  test('every catalog entry has an id and a display name', () => {
    for (const agent of listSupportedAgents()) {
      expect(agent.id.length).toBeGreaterThan(0)
      expect(agent.displayName.length).toBeGreaterThan(0)
    }
  })

  test('recognizes agents added in the 1.5.22 refresh', () => {
    for (const id of ['minimax-code', 'zed', 'grok', 'kimchi', 'ona']) {
      expect(isAgentSupported(id)).toBe(true)
    }
  })

  test('resolves a new agent to its default skills directory', () => {
    expect(
      resolveAgentSkillsDir('minimax-code').endsWith('.minimax/skills'),
    ).toBe(true)
  })

  test('adopts the kimi-cli to kimi-code-cli rename', () => {
    expect(isAgentSupported('kimi-cli')).toBe(false)
    expect(isAgentSupported('kimi-code-cli')).toBe(true)
  })
})
