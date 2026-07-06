import { describe, expect, test } from 'bun:test'

import {
  ForeignEntryError,
  ServerNotFoundError,
  UnsupportedTransportError,
} from '../../src/errors.ts'
import {
  planAdd,
  planDisconnect,
  planLink,
  planRemove,
  planRescan,
  planUnlink,
} from '../../src/planner/planner.ts'
import type { State } from '../../src/planner/types.ts'
import type {
  AgentId,
  ManifestServerEntry,
  McpServerSpec,
  ServerManifest,
} from '../../src/types.ts'

const NOW = '2026-07-06T12:00:00Z'

const STDIO_SPEC: McpServerSpec = {
  transport: 'stdio',
  command: 'gh-mcp',
  args: ['serve'],
}

const HTTP_SPEC: McpServerSpec = {
  transport: 'http',
  url: 'https://example.com/mcp',
}

function emptyManifest(): ServerManifest {
  return { version: 1, servers: {} }
}

function serverEntry(
  overrides: Partial<ManifestServerEntry> = {},
): ManifestServerEntry {
  return {
    name: 'gh',
    spec: STDIO_SPEC,
    addedAt: NOW,
    links: {},
    ...overrides,
  }
}

function baseState(overrides: Partial<State> = {}): State {
  return {
    workspaceDir: '/tmp/ws',
    manifestPath: '/tmp/ws/manifest.json',
    manifest: emptyManifest(),
    agents: [],
    ...overrides,
  }
}

function stateWithServer(
  server: ManifestServerEntry,
  extras: Partial<State> = {},
): State {
  return baseState({
    manifest: { version: 1, servers: { [server.name]: server } },
    ...extras,
  })
}

function agentFile(
  agent: AgentId,
  configPath: string,
  raw = '',
  scope: 'system' | 'project' = 'system',
) {
  return { agent, scope, configPath, rawContent: raw, exists: raw.length > 0 }
}

// -------------------------------------------------------------------
// planAdd
// -------------------------------------------------------------------

describe('planAdd', () => {
  test('creates a new server entry and one manifest write op', () => {
    const state = baseState()
    const plan = planAdd(state, { name: 'gh', spec: STDIO_SPEC }, NOW)
    expect(plan.created).toBe(true)
    expect(plan.nextManifest.servers.gh?.name).toBe('gh')
    expect(plan.nextManifest.servers.gh?.spec).toEqual(STDIO_SPEC)
    expect(plan.nextManifest.servers.gh?.links).toEqual({})
    expect(plan.ops).toHaveLength(1)
    expect(plan.ops[0]?.kind).toBe('writeFile')
  })

  test('replacing an existing server preserves addedAt and links', () => {
    const state = stateWithServer(
      serverEntry({
        addedAt: '2020-01-01T00:00:00Z',
        links: { cursor: { configPath: '/x', createdAt: NOW } },
      }),
    )
    const plan = planAdd(state, { name: 'gh', spec: HTTP_SPEC }, NOW)
    expect(plan.created).toBe(false)
    expect(plan.nextManifest.servers.gh?.spec).toEqual(HTTP_SPEC)
    expect(plan.nextManifest.servers.gh?.addedAt).toBe('2020-01-01T00:00:00Z')
    expect(plan.nextManifest.servers.gh?.links.cursor).toBeDefined()
  })

  test('rejects empty name', () => {
    expect(() =>
      planAdd(baseState(), { name: '  ', spec: STDIO_SPEC }, NOW),
    ).toThrow()
  })

  test('rejects stdio spec with empty command', () => {
    expect(() =>
      planAdd(
        baseState(),
        { name: 'x', spec: { transport: 'stdio', command: '' } },
        NOW,
      ),
    ).toThrow()
  })

  test('rejects http spec with empty url', () => {
    expect(() =>
      planAdd(
        baseState(),
        { name: 'x', spec: { transport: 'http', url: '' } },
        NOW,
      ),
    ).toThrow()
  })
})

// -------------------------------------------------------------------
// planLink
// -------------------------------------------------------------------

describe('planLink', () => {
  test('links a server to an agent, adding to config file and manifest', () => {
    const state = stateWithServer(serverEntry(), {
      agents: [agentFile('cursor', '/tmp/ws/cursor.json')],
    })
    const plan = planLink(state, { serverName: 'gh', agent: 'cursor' }, NOW)
    expect(plan.created).toBe(true)
    expect(plan.overwroteForeign).toBe(false)
    expect(plan.ops).toHaveLength(2)
    expect(plan.nextManifest.servers.gh?.links.cursor?.configPath).toBe(
      '/tmp/ws/cursor.json',
    )
  })

  test('throws ServerNotFoundError for unknown server', () => {
    expect(() =>
      planLink(baseState(), { serverName: 'ghost', agent: 'cursor' }, NOW),
    ).toThrow(ServerNotFoundError)
  })

  test('throws UnsupportedTransportError when transport not accepted', () => {
    const state = stateWithServer(serverEntry({ spec: HTTP_SPEC }), {
      agents: [agentFile('claude-desktop', '/tmp/ws/claude.json')],
    })
    expect(() =>
      planLink(state, { serverName: 'gh', agent: 'claude-desktop' }, NOW),
    ).toThrow(UnsupportedTransportError)
  })

  test('throws ForeignEntryError when config already has the entry', () => {
    // Cursor's mcp.json already has an entry named `gh` that manifest
    // didn't put there.
    const foreignJson = JSON.stringify({
      mcpServers: { gh: { command: 'other-thing' } },
    })
    const state = stateWithServer(serverEntry(), {
      agents: [agentFile('cursor', '/tmp/ws/cursor.json', foreignJson)],
    })
    expect(() =>
      planLink(state, { serverName: 'gh', agent: 'cursor' }, NOW),
    ).toThrow(ForeignEntryError)
  })

  test('allowOverwrite: true takes ownership of the foreign entry', () => {
    const foreignJson = JSON.stringify({
      mcpServers: { gh: { command: 'other-thing' } },
    })
    const state = stateWithServer(serverEntry(), {
      agents: [agentFile('cursor', '/tmp/ws/cursor.json', foreignJson)],
    })
    const plan = planLink(
      state,
      { serverName: 'gh', agent: 'cursor', allowOverwrite: true },
      NOW,
    )
    expect(plan.overwroteForeign).toBe(true)
    expect(plan.created).toBe(true)
  })
})

// -------------------------------------------------------------------
// planUnlink
// -------------------------------------------------------------------

describe('planUnlink', () => {
  test('no-op when server not in manifest', () => {
    const plan = planUnlink(baseState(), {
      serverName: 'ghost',
      agent: 'cursor',
    })
    expect(plan.removed).toBe(false)
    expect(plan.ops).toEqual([])
  })

  test('no-op when agent has no link', () => {
    const state = stateWithServer(serverEntry())
    const plan = planUnlink(state, { serverName: 'gh', agent: 'cursor' })
    expect(plan.removed).toBe(false)
  })

  test('removes the link and rewrites the config file when the entry exists on disk', () => {
    const configJson = JSON.stringify({
      mcpServers: { gh: { command: 'gh-mcp' } },
    })
    const state = stateWithServer(
      serverEntry({
        links: {
          cursor: { configPath: '/tmp/ws/cursor.json', createdAt: NOW },
        },
      }),
      { agents: [agentFile('cursor', '/tmp/ws/cursor.json', configJson)] },
    )
    const plan = planUnlink(state, { serverName: 'gh', agent: 'cursor' })
    expect(plan.removed).toBe(true)
    expect(plan.nextManifest.servers.gh?.links.cursor).toBeUndefined()
    expect(plan.ops).toHaveLength(2)
  })
})

// -------------------------------------------------------------------
// planDisconnect — the #63 primitive
// -------------------------------------------------------------------

describe('planDisconnect (closes #63)', () => {
  test('unlinks a single agent and drops the manifest entry when it was the last', () => {
    const configJson = JSON.stringify({
      mcpServers: { gh: { command: 'gh-mcp' } },
    })
    const state = stateWithServer(
      serverEntry({
        links: {
          cursor: { configPath: '/tmp/ws/cursor.json', createdAt: NOW },
        },
      }),
      { agents: [agentFile('cursor', '/tmp/ws/cursor.json', configJson)] },
    )
    const plan = planDisconnect(state, { serverName: 'gh', agent: 'cursor' })
    expect(plan.unlinked).toBe(true)
    expect(plan.removedManifest).toBe(true)
    expect(plan.nextManifest.servers.gh).toBeUndefined()
  })

  test('DOES NOT drop the manifest entry when other agents remain linked', () => {
    // This is the exact #63 scenario. Disconnecting Cursor from a
    // server that Claude Code, VS Code, and Gemini also have registered
    // must leave those three agents completely untouched.
    const state = stateWithServer(
      serverEntry({
        links: {
          cursor: { configPath: '/tmp/ws/cursor.json', createdAt: NOW },
          'claude-code': { configPath: '/tmp/ws/claude.json', createdAt: NOW },
          vscode: { configPath: '/tmp/ws/vscode.json', createdAt: NOW },
          gemini: { configPath: '/tmp/ws/gemini.json', createdAt: NOW },
        },
      }),
      {
        agents: [
          agentFile(
            'cursor',
            '/tmp/ws/cursor.json',
            JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp' } } }),
          ),
          // The other three agents' files are read but not modified.
          agentFile(
            'claude-code',
            '/tmp/ws/claude.json',
            JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp' } } }),
          ),
          agentFile(
            'vscode',
            '/tmp/ws/vscode.json',
            JSON.stringify({
              servers: { gh: { command: 'gh-mcp', type: 'stdio' } },
            }),
          ),
          agentFile(
            'gemini',
            '/tmp/ws/gemini.json',
            JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp' } } }),
          ),
        ],
      },
    )
    const plan = planDisconnect(state, { serverName: 'gh', agent: 'cursor' })
    expect(plan.unlinked).toBe(true)
    expect(plan.removedManifest).toBe(false)
    // Manifest still has the entry; three links remain.
    const remainingEntry = plan.nextManifest.servers.gh
    expect(remainingEntry).toBeDefined()
    expect(Object.keys(remainingEntry?.links ?? {}).sort()).toEqual([
      'claude-code',
      'gemini',
      'vscode',
    ])
    // Ops touch only Cursor's file and the manifest.
    const writePaths = plan.ops
      .filter((op) => op.kind === 'writeFile')
      .map((op) => (op.kind === 'writeFile' ? op.path : ''))
    expect(writePaths).toContain('/tmp/ws/cursor.json')
    expect(writePaths).toContain('/tmp/ws/manifest.json')
    expect(writePaths).not.toContain('/tmp/ws/claude.json')
    expect(writePaths).not.toContain('/tmp/ws/vscode.json')
    expect(writePaths).not.toContain('/tmp/ws/gemini.json')
  })

  test('removeIfLast: false keeps the manifest entry with empty links map', () => {
    const state = stateWithServer(
      serverEntry({
        links: {
          cursor: { configPath: '/tmp/ws/cursor.json', createdAt: NOW },
        },
      }),
      {
        agents: [
          agentFile(
            'cursor',
            '/tmp/ws/cursor.json',
            JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp' } } }),
          ),
        ],
      },
    )
    const plan = planDisconnect(state, {
      serverName: 'gh',
      agent: 'cursor',
      removeIfLast: false,
    })
    expect(plan.removedManifest).toBe(false)
    expect(plan.nextManifest.servers.gh?.links).toEqual({})
  })

  test('no-op when the agent was never linked', () => {
    const state = stateWithServer(serverEntry())
    const plan = planDisconnect(state, { serverName: 'gh', agent: 'cursor' })
    expect(plan.unlinked).toBe(false)
    expect(plan.removedManifest).toBe(false)
    expect(plan.ops).toEqual([])
  })
})

// -------------------------------------------------------------------
// planRemove
// -------------------------------------------------------------------

describe('planRemove', () => {
  test('drops manifest entry and unlinks every currently-linked agent by default', () => {
    const state = stateWithServer(
      serverEntry({
        links: {
          cursor: { configPath: '/tmp/ws/cursor.json', createdAt: NOW },
          gemini: { configPath: '/tmp/ws/gemini.json', createdAt: NOW },
        },
      }),
      {
        agents: [
          agentFile(
            'cursor',
            '/tmp/ws/cursor.json',
            JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp' } } }),
          ),
          agentFile(
            'gemini',
            '/tmp/ws/gemini.json',
            JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp' } } }),
          ),
        ],
      },
    )
    const plan = planRemove(state, { serverName: 'gh' })
    expect(plan.removedManifest).toBe(true)
    expect(plan.unlinkedAgents.sort()).toEqual(['cursor', 'gemini'])
    expect(plan.nextManifest.servers.gh).toBeUndefined()
    const paths = plan.ops
      .filter((op) => op.kind === 'writeFile')
      .map((op) => (op.kind === 'writeFile' ? op.path : ''))
    expect(paths).toContain('/tmp/ws/cursor.json')
    expect(paths).toContain('/tmp/ws/gemini.json')
    expect(paths).toContain('/tmp/ws/manifest.json')
  })

  test('unlinkFirst: false drops the manifest entry without touching agent files', () => {
    const state = stateWithServer(
      serverEntry({
        links: {
          cursor: { configPath: '/tmp/ws/cursor.json', createdAt: NOW },
        },
      }),
    )
    const plan = planRemove(state, { serverName: 'gh', unlinkFirst: false })
    expect(plan.removedManifest).toBe(true)
    expect(plan.unlinkedAgents).toEqual([])
    expect(
      plan.ops.filter(
        (op) => op.kind === 'writeFile' && op.path.includes('cursor'),
      ),
    ).toHaveLength(0)
  })

  test('no-op when server not in manifest', () => {
    const plan = planRemove(baseState(), { serverName: 'ghost' })
    expect(plan.removedManifest).toBe(false)
    expect(plan.ops).toEqual([])
  })
})

// -------------------------------------------------------------------
// planRescan
// -------------------------------------------------------------------

describe('planRescan', () => {
  test('reports verified links when the on-disk entry matches', () => {
    const state = stateWithServer(
      serverEntry({
        links: {
          cursor: { configPath: '/tmp/ws/cursor.json', createdAt: NOW },
        },
      }),
      {
        agents: [
          agentFile(
            'cursor',
            '/tmp/ws/cursor.json',
            JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp' } } }),
          ),
        ],
      },
    )
    const { rescan } = planRescan(state)
    expect(rescan.verified).toHaveLength(1)
    expect(rescan.drifted).toHaveLength(0)
    expect(rescan.missing).toHaveLength(0)
  })

  test('reports drift when config has no matching entry', () => {
    const state = stateWithServer(
      serverEntry({
        links: {
          cursor: { configPath: '/tmp/ws/cursor.json', createdAt: NOW },
        },
      }),
      {
        agents: [
          agentFile(
            'cursor',
            '/tmp/ws/cursor.json',
            JSON.stringify({ mcpServers: {} }),
          ),
        ],
      },
    )
    const { rescan } = planRescan(state)
    expect(rescan.drifted).toHaveLength(1)
    expect(rescan.drifted[0]?.serverName).toBe('gh')
  })

  test('reports missing when the file does not exist', () => {
    const state = stateWithServer(
      serverEntry({
        links: {
          cursor: { configPath: '/tmp/ws/cursor.json', createdAt: NOW },
        },
      }),
      { agents: [agentFile('cursor', '/tmp/ws/cursor.json', '')] },
    )
    const { rescan } = planRescan(state)
    expect(rescan.missing).toHaveLength(1)
  })

  test('filter by agents narrows the scan', () => {
    const state = stateWithServer(
      serverEntry({
        links: {
          cursor: { configPath: '/tmp/ws/cursor.json', createdAt: NOW },
          gemini: { configPath: '/tmp/ws/gemini.json', createdAt: NOW },
        },
      }),
      {
        agents: [
          agentFile(
            'cursor',
            '/tmp/ws/cursor.json',
            JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp' } } }),
          ),
          agentFile(
            'gemini',
            '/tmp/ws/gemini.json',
            JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp' } } }),
          ),
        ],
      },
    )
    const { rescan } = planRescan(state, { agents: ['cursor'] })
    expect(rescan.verified).toHaveLength(1)
    expect(rescan.verified[0]?.agent).toBe('cursor')
  })

  test('returns no ops (rescan is read-only)', () => {
    const { ops } = planRescan(baseState())
    expect(ops).toEqual([])
  })
})

// -------------------------------------------------------------------
// Cross-cutting invariants
// -------------------------------------------------------------------

describe('planner invariants', () => {
  test('a plan is a value; calling twice on the same state returns equivalent ops', () => {
    const state = stateWithServer(serverEntry(), {
      agents: [agentFile('cursor', '/tmp/ws/cursor.json')],
    })
    const a = planLink(state, { serverName: 'gh', agent: 'cursor' }, NOW)
    const b = planLink(state, { serverName: 'gh', agent: 'cursor' }, NOW)
    expect(a.ops).toEqual(b.ops)
    expect(a.nextManifest).toEqual(b.nextManifest)
  })

  test('planners never mutate the input state', () => {
    const state = stateWithServer(serverEntry(), {
      agents: [agentFile('cursor', '/tmp/ws/cursor.json')],
    })
    const before = JSON.stringify(state.manifest)
    planLink(state, { serverName: 'gh', agent: 'cursor' }, NOW)
    planAdd(state, { name: 'gh', spec: HTTP_SPEC }, NOW)
    expect(JSON.stringify(state.manifest)).toBe(before)
  })
})
