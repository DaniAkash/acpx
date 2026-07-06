import { describe, expect, test } from 'bun:test'

import { inferShape, STDIO_PROBE } from '../../scripts/lib/infer-shape.ts'
import { evaluate, parse } from '../../scripts/lib/yq.ts'

function infer(expr: string) {
  const trace = evaluate(parse(expr), STDIO_PROBE as never)
  return inferShape(trace)
}

describe('inferShape: docker upstream expressions', () => {
  test('claude-desktop / claude-code / cursor / gemini / kiro / lmstudio / cline', () => {
    const s = infer('.mcpServers[$NAME] = $JSON')
    expect(s.parentPath).toEqual(['mcpServers'])
    expect(s.keyTransform).toBe('identity')
    expect(s.arrayShape).toBe(false)
    expect(s.injectFields).toEqual({})
    expect(s.transportTagKey).toBeUndefined()
    expect(s.commandAsArray).toBe(false)
    expect(s.fieldRenames).toEqual({})
  })

  test('vscode: injects type=stdio tag', () => {
    const s = infer('.servers[$NAME] = $JSON+{"type":"stdio"}')
    expect(s.parentPath).toEqual(['servers'])
    expect(s.transportTagKey).toBe('type')
    expect(s.injectFields).toEqual({})
  })

  test('sema4: uses transport (not type) tag key', () => {
    const s = infer('.mcpServers[$NAME] = $JSON+{"transport":"stdio"}')
    expect(s.transportTagKey).toBe('transport')
  })

  test('zed: injects source=custom, enabled=true', () => {
    const s = infer(
      '.context_servers[$NAME] = {"source":"custom","enabled":true}+$JSON',
    )
    expect(s.parentPath).toEqual(['context_servers'])
    expect(s.injectFields).toEqual({ source: 'custom', enabled: true })
    expect(s.transportTagKey).toBeUndefined()
  })

  test('crush: mcp parent + type=stdio tag', () => {
    const s = infer('.mcp[$NAME] = $JSON+{"type":"stdio"}')
    expect(s.parentPath).toEqual(['mcp'])
    expect(s.transportTagKey).toBe('type')
  })

  test('claude-code project scope: mcpServers + type=stdio tag', () => {
    const s = infer('.mcpServers[$NAME] = $JSON+{"type":"stdio"}')
    expect(s.parentPath).toEqual(['mcpServers'])
    expect(s.transportTagKey).toBe('type')
  })

  test('opencode: commandAsArray true; injects type=local, enabled=true', () => {
    const s = infer(
      '.mcp[$NAME] = {"type":"local","command":[$JSON.command]+$JSON.args,"enabled":true}',
    )
    expect(s.parentPath).toEqual(['mcp'])
    expect(s.commandAsArray).toBe(true)
    expect(s.injectFields).toEqual({ type: 'local', enabled: true })
    expect(s.transportTagKey).toBeUndefined()
  })

  test('continue.dev: array-shape + name field marker', () => {
    const s = infer(
      '.mcpServers = (.mcpServers // []) | .mcpServers += [{"name":$NAME}+$JSON]',
    )
    expect(s.parentPath).toEqual(['mcpServers'])
    expect(s.arrayShape).toBe(true)
    expect(s.keyTransform).toBe('identity')
  })

  test('goose: SIMPLE_NAME + command rename + literal injects (upstream shape)', () => {
    // Upstream docker/mcp-gateway writes `envs: {}` as a LITERAL empty
    // object regardless of $JSON.env, and hardcodes several other fields
    // (bundled, description, enabled, env_keys, name, timeout). Only cmd
    // gets sourced from $JSON.command. That's docker's deliberate design
    // and the emitter shape must reflect it (envs is treated as an inject,
    // not a rename).
    const s = infer(`.extensions[$SIMPLE_NAME] = {
      "args": $JSON.args,
      "bundled": null,
      "cmd": $JSON.command,
      "description": "managed",
      "enabled": true,
      "env_keys": [],
      "envs": {},
      "name": $SIMPLE_NAME,
      "timeout": 300,
      "type": "stdio"
    }`)
    expect(s.parentPath).toEqual(['extensions'])
    expect(s.keyTransform).toBe('simpleName')
    expect(s.transportTagKey).toBe('type')
    expect(s.fieldRenames.command).toBe('cmd')
    expect(s.fieldRenames.env).toBeUndefined()
    expect(s.injectFields.bundled).toBeNull()
    expect(s.injectFields.description).toBe('managed')
    expect(s.injectFields.enabled).toBe(true)
    expect(s.injectFields.envs).toEqual({})
    expect(s.injectFields.timeout).toBe(300)
  })
})
