import { describe, expect, test } from 'bun:test'
import { parseSourceInput } from '../../src/source.ts'

describe('parseSourceInput', () => {
  test('owner/repo shorthand', () => {
    expect(parseSourceInput('vercel-labs/skills')).toEqual({
      kind: 'github',
      ownerRepo: 'vercel-labs/skills',
    })
  })

  test('owner/repo with ref', () => {
    expect(parseSourceInput('vercel-labs/skills#v1.2.3')).toEqual({
      kind: 'github',
      ownerRepo: 'vercel-labs/skills',
      ref: 'v1.2.3',
    })
  })

  test('github https URL', () => {
    expect(parseSourceInput('https://github.com/vercel-labs/skills')).toEqual({
      kind: 'github',
      ownerRepo: 'vercel-labs/skills',
    })
  })

  test('github https URL with .git and ref', () => {
    expect(
      parseSourceInput('https://github.com/vercel-labs/skills.git#main'),
    ).toEqual({
      kind: 'github',
      ownerRepo: 'vercel-labs/skills',
      ref: 'main',
    })
  })

  test('generic git URL', () => {
    expect(parseSourceInput('https://gitlab.com/group/repo.git')).toEqual({
      kind: 'gitUrl',
      url: 'https://gitlab.com/group/repo.git',
    })
  })

  test('generic git URL with ref', () => {
    expect(parseSourceInput('git@github.com:owner/repo.git#tag')).toEqual({
      kind: 'gitUrl',
      url: 'git@github.com:owner/repo.git',
      ref: 'tag',
    })
  })

  test('ssh scheme git URL', () => {
    expect(
      parseSourceInput('ssh://git@github.com:7999/owner/repo.git'),
    ).toEqual({
      kind: 'gitUrl',
      url: 'ssh://git@github.com:7999/owner/repo.git',
    })
  })

  test('resolves the vercel-labs repo-rename shorthand alias', () => {
    expect(parseSourceInput('vercel-labs/vercel-skills')).toEqual({
      kind: 'github',
      ownerRepo: 'vercel-labs/agent-skills',
    })
  })

  test('local absolute path', () => {
    const here = process.cwd()
    expect(parseSourceInput(here)).toEqual({ kind: 'local', path: here })
  })

  test('local relative path', () => {
    const here = process.cwd()
    // Use the package's own `src/` — always exists when tests run.
    const inputs = [
      './packages/agent-skills-manager/src',
      'packages/agent-skills-manager/src',
      './src',
    ]
    const tried = inputs
      .map((rel) => {
        try {
          return parseSourceInput(rel)
        } catch {
          return null
        }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
    expect(tried.length).toBeGreaterThan(0)
    expect(tried[0]).toMatchObject({ kind: 'local' })
    expect((tried[0] as { path: string }).path.startsWith(here)).toBe(true)
  })

  test('rejects empty input', () => {
    expect(() => parseSourceInput('')).toThrow(/Empty source/)
  })

  test('rejects nonexistent local path', () => {
    expect(() => parseSourceInput('./does-not-exist-anywhere')).toThrow(
      /Unrecognized source/,
    )
  })
})
