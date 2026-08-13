import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createSkillsManager } from '../../src/index.ts'
import {
  makeTmpWorkspace,
  type TmpWorkspace,
  writeSkillSource,
} from '../helpers/tmp-workspace.ts'

let tmp: TmpWorkspace

beforeEach(async () => {
  tmp = await makeTmpWorkspace()
})

afterEach(async () => {
  await tmp.cleanup()
})

describe('add() with a local source', () => {
  test('copies bundle into workspace and records manifest metadata', async () => {
    const src = join(tmp.root, 'src-skill')
    await writeSkillSource(src, { name: 'my-skill', description: 'test' })

    const mgr = createSkillsManager({ workspaceDir: tmp.workspaceDir })
    const result = await mgr.add({ source: src })

    expect(result.added).toHaveLength(1)
    expect(result.added[0]?.name).toBe('my-skill')
    expect(result.added[0]?.workspacePath).toBe(
      join(tmp.workspaceDir, 'my-skill'),
    )
    expect(
      (await stat(join(tmp.workspaceDir, 'my-skill/SKILL.md'))).isFile(),
    ).toBe(true)

    const manifest = JSON.parse(
      await readFile(join(tmp.workspaceDir, '.manifest.json'), 'utf8'),
    )
    expect(manifest.version).toBe(1)
    expect(manifest.skills['my-skill']).toMatchObject({
      name: 'my-skill',
      description: 'test',
      source: { kind: 'local', path: src },
      links: {},
    })
    expect(typeof manifest.skills['my-skill'].addedAt).toBe('string')

    const listed = await mgr.listSkills()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.name).toBe('my-skill')
    expect(listed[0]?.source).toEqual({ kind: 'local', path: src })
    expect(listed[0]?.addedAt).toBeDefined()
  })

  test('symlink localMode points workspace entry at the source', async () => {
    const src = join(tmp.root, 'src-skill')
    await writeSkillSource(src, { name: 'live', description: 'live edit me' })

    const mgr = createSkillsManager({ workspaceDir: tmp.workspaceDir })
    await mgr.add({ source: src, localMode: 'symlink' })

    const linkStat = await stat(join(tmp.workspaceDir, 'live'))
    expect(linkStat.isDirectory()).toBe(true)
    const skillMdContent = await readFile(
      join(tmp.workspaceDir, 'live/SKILL.md'),
      'utf8',
    )
    expect(skillMdContent).toContain('name: live')
  })

  test('discovers skills nested under category directories', async () => {
    const src = join(tmp.root, 'multi')
    await writeSkillSource(join(src, 'category-a', 'skill-1'), {
      name: 'skill-1',
      description: 'first',
    })
    await writeSkillSource(join(src, 'category-b', 'skill-2'), {
      name: 'skill-2',
      description: 'second',
    })

    const mgr = createSkillsManager({ workspaceDir: tmp.workspaceDir })
    const result = await mgr.add({ source: src })

    expect(result.added).toHaveLength(2)
    const names = result.added.map((a) => a.name).sort()
    expect(names).toEqual(['skill-1', 'skill-2'])
  })

  test('failed source (no SKILL.md) returns a failed result entry', async () => {
    const src = join(tmp.root, 'empty-src')
    await (await import('node:fs/promises')).mkdir(src, { recursive: true })
    const mgr = createSkillsManager({ workspaceDir: tmp.workspaceDir })
    const result = await mgr.add({ source: src })
    expect(result.added).toHaveLength(0)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.error).toMatch(/No SKILL.md/)
  })
})
