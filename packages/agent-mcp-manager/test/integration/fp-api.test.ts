import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addServer,
  bind,
  disconnect,
  link,
  list,
  listLinks,
  remove,
  unlink,
} from '../../src/api.ts'
import { readState } from '../../src/io/index.ts'

let workspaceDir: string
let cursorPath: string
let geminiPath: string
let claudeCodePath: string

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'acpx-api-'))
  cursorPath = join(workspaceDir, 'cursor.json')
  geminiPath = join(workspaceDir, 'gemini.json')
  claudeCodePath = join(workspaceDir, 'claude.json')
})

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true })
})

describe('addServer', () => {
  test('creates a server entry and writes the manifest', async () => {
    const res = await addServer(workspaceDir, {
      name: 'gh',
      spec: { transport: 'stdio', command: 'gh-mcp' },
    })
    expect(res).toEqual({ name: 'gh', created: true })
    const state = await readState(workspaceDir)
    expect(state.manifest.servers.gh?.spec).toEqual({
      transport: 'stdio',
      command: 'gh-mcp',
    })
  })

  test('re-adding the same name returns created: false and updates the spec', async () => {
    await addServer(workspaceDir, {
      name: 'gh',
      spec: { transport: 'stdio', command: 'gh-mcp' },
    })
    const res = await addServer(workspaceDir, {
      name: 'gh',
      spec: { transport: 'http', url: 'https://x/mcp' },
    })
    expect(res.created).toBe(false)
    const state = await readState(workspaceDir)
    expect(state.manifest.servers.gh?.spec).toEqual({
      transport: 'http',
      url: 'https://x/mcp',
    })
  })
})

describe('link', () => {
  test('writes the agent config and updates the manifest', async () => {
    await addServer(workspaceDir, {
      name: 'gh',
      spec: { transport: 'stdio', command: 'gh-mcp' },
    })
    const res = await link(workspaceDir, {
      serverName: 'gh',
      agent: 'cursor',
      configPath: cursorPath,
    })
    expect(res.created).toBe(true)
    const raw = await readFile(cursorPath, 'utf8')
    expect(JSON.parse(raw).mcpServers.gh.command).toBe('gh-mcp')
  })
})

describe('disconnect (regression test for #63)', () => {
  test('disconnecting one of four linked agents does NOT touch the other three', async () => {
    await addServer(workspaceDir, {
      name: 'gh',
      spec: { transport: 'stdio', command: 'gh-mcp' },
    })
    await link(workspaceDir, {
      serverName: 'gh',
      agent: 'cursor',
      configPath: cursorPath,
    })
    await link(workspaceDir, {
      serverName: 'gh',
      agent: 'gemini',
      configPath: geminiPath,
    })
    await link(workspaceDir, {
      serverName: 'gh',
      agent: 'claude-code',
      configPath: claudeCodePath,
    })

    const before = {
      gemini: await readFile(geminiPath, 'utf8'),
      claudeCode: await readFile(claudeCodePath, 'utf8'),
    }

    const res = await disconnect(workspaceDir, {
      serverName: 'gh',
      agent: 'cursor',
    })
    expect(res.unlinked).toBe(true)
    // Two agents still linked: manifest entry stays.
    expect(res.removedManifest).toBe(false)

    // Cursor's file loses the entry.
    const cursorAfter = await readFile(cursorPath, 'utf8')
    expect(JSON.parse(cursorAfter).mcpServers.gh).toBeUndefined()

    // The other two agents' files are byte-for-byte untouched.
    expect(await readFile(geminiPath, 'utf8')).toBe(before.gemini)
    expect(await readFile(claudeCodePath, 'utf8')).toBe(before.claudeCode)

    // Manifest still has the entry with the two remaining links.
    const state = await readState(workspaceDir)
    expect(state.manifest.servers.gh).toBeDefined()
    expect(Object.keys(state.manifest.servers.gh?.links ?? {}).sort()).toEqual([
      'claude-code',
      'gemini',
    ])
  })

  test('disconnecting the last agent drops the manifest entry by default', async () => {
    await addServer(workspaceDir, {
      name: 'solo',
      spec: { transport: 'stdio', command: 'solo-mcp' },
    })
    await link(workspaceDir, {
      serverName: 'solo',
      agent: 'cursor',
      configPath: cursorPath,
    })
    const res = await disconnect(workspaceDir, {
      serverName: 'solo',
      agent: 'cursor',
    })
    expect(res.removedManifest).toBe(true)
    const state = await readState(workspaceDir)
    expect(state.manifest.servers.solo).toBeUndefined()
  })
})

describe('unlink + list + listLinks + remove', () => {
  test('unlink is idempotent when the link does not exist', async () => {
    await addServer(workspaceDir, {
      name: 'gh',
      spec: { transport: 'stdio', command: 'gh-mcp' },
    })
    const res = await unlink(workspaceDir, {
      serverName: 'gh',
      agent: 'cursor',
      configPath: cursorPath,
    })
    expect(res.removed).toBe(false)
  })

  test('list returns every manifest server entry', async () => {
    await addServer(workspaceDir, {
      name: 'a',
      spec: { transport: 'stdio', command: 'a' },
    })
    await addServer(workspaceDir, {
      name: 'b',
      spec: { transport: 'http', url: 'https://b' },
    })
    const items = await list(workspaceDir)
    expect(items.map((s) => s.name).sort()).toEqual(['a', 'b'])
  })

  test('listLinks reports every (server, agent, configPath) triple', async () => {
    await addServer(workspaceDir, {
      name: 'gh',
      spec: { transport: 'stdio', command: 'gh-mcp' },
    })
    await link(workspaceDir, {
      serverName: 'gh',
      agent: 'cursor',
      configPath: cursorPath,
    })
    await link(workspaceDir, {
      serverName: 'gh',
      agent: 'gemini',
      configPath: geminiPath,
    })
    const links = await listLinks(workspaceDir)
    expect(links.map((l) => l.agent).sort()).toEqual(['cursor', 'gemini'])
  })

  test('remove drops the manifest entry and unlinks every currently-linked agent', async () => {
    await addServer(workspaceDir, {
      name: 'gh',
      spec: { transport: 'stdio', command: 'gh-mcp' },
    })
    await link(workspaceDir, {
      serverName: 'gh',
      agent: 'cursor',
      configPath: cursorPath,
    })
    await link(workspaceDir, {
      serverName: 'gh',
      agent: 'gemini',
      configPath: geminiPath,
    })
    const res = await remove(workspaceDir, { serverName: 'gh' })
    expect(res.removedManifest).toBe(true)
    expect(res.unlinkedAgents.sort()).toEqual(['cursor', 'gemini'])
    // Both files should have the entry dropped.
    expect(
      JSON.parse(await readFile(cursorPath, 'utf8')).mcpServers.gh,
    ).toBeUndefined()
    expect(
      JSON.parse(await readFile(geminiPath, 'utf8')).mcpServers.gh,
    ).toBeUndefined()
  })
})

describe('bind', () => {
  test('applies the workspaceDir to every verb', async () => {
    const mgr = bind(workspaceDir)
    await mgr.addServer({
      name: 'gh',
      spec: { transport: 'stdio', command: 'gh-mcp' },
    })
    await mgr.link({
      serverName: 'gh',
      agent: 'cursor',
      configPath: cursorPath,
    })
    const links = await mgr.listLinks()
    expect(links).toHaveLength(1)
  })
})
