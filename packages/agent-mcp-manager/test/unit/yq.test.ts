import { describe, expect, test } from 'bun:test'

import { evaluate, parse, tokenize, YqError } from '../../scripts/lib/yq.ts'

const STDIO_SPEC = {
  command: 'gh-mcp',
  args: ['serve'],
  env: { KEY: 'val' },
}

function run(
  expr: string,
  env: Record<string, unknown> = {},
  initial: unknown = {},
) {
  return evaluate(parse(expr), env, initial)
}

describe('yq lexer', () => {
  test('tokenises the claude-desktop expression', () => {
    const toks = tokenize('.mcpServers[$NAME] = $JSON')
    expect(toks.map((t) => t.kind)).toEqual([
      'dot',
      'ident',
      'lbracket',
      'variable',
      'rbracket',
      'assign',
      'variable',
    ])
  })

  test('recognises the += append operator', () => {
    const toks = tokenize('.foo += [$JSON]')
    expect(toks.map((t) => t.kind)).toEqual([
      'dot',
      'ident',
      'append',
      'lbracket',
      'variable',
      'rbracket',
    ])
  })

  test('recognises the // null-coalesce operator', () => {
    const toks = tokenize('.foo // []')
    expect(toks.map((t) => t.kind)).toEqual([
      'dot',
      'ident',
      'coalesce',
      'lbracket',
      'rbracket',
    ])
  })

  test('parses string literals with escapes', () => {
    const toks = tokenize('{"a\\"b": "c"}')
    expect(toks[1]?.kind === 'string' && toks[1]?.value).toBe('a"b')
  })

  test('parses null keyword', () => {
    const toks = tokenize('{"a": null}')
    expect(toks.some((t) => t.kind === 'null')).toBe(true)
  })

  test('throws on unexpected char', () => {
    expect(() => tokenize('!!!')).toThrow(YqError)
  })
})

describe('yq: docker/mcp-gateway expressions execute end-to-end', () => {
  test('claude-desktop: .mcpServers[$NAME] = $JSON', () => {
    const trace = run('.mcpServers[$NAME] = $JSON', {
      NAME: 'gh',
      JSON: STDIO_SPEC,
    })
    expect(trace.finalDoc).toEqual({
      mcpServers: { gh: STDIO_SPEC },
    })
  })

  test('vscode: .servers[$NAME] = $JSON+{"type":"stdio"}', () => {
    const trace = run('.servers[$NAME] = $JSON+{"type":"stdio"}', {
      NAME: 'gh',
      JSON: STDIO_SPEC,
    })
    expect(trace.finalDoc).toEqual({
      servers: { gh: { ...STDIO_SPEC, type: 'stdio' } },
    })
  })

  test('sema4: .mcpServers[$NAME] = $JSON+{"transport":"stdio"}', () => {
    const trace = run('.mcpServers[$NAME] = $JSON+{"transport":"stdio"}', {
      NAME: 'gh',
      JSON: STDIO_SPEC,
    })
    expect(trace.finalDoc).toEqual({
      mcpServers: { gh: { ...STDIO_SPEC, transport: 'stdio' } },
    })
  })

  test('zed: .context_servers[$NAME] = {"source":"custom","enabled":true}+$JSON', () => {
    const trace = run(
      '.context_servers[$NAME] = {"source":"custom","enabled":true}+$JSON',
      { NAME: 'gh', JSON: STDIO_SPEC },
    )
    expect(trace.finalDoc).toEqual({
      context_servers: {
        gh: { source: 'custom', enabled: true, ...STDIO_SPEC },
      },
    })
  })

  test('crush: .mcp[$NAME] = $JSON+{"type":"stdio"}', () => {
    const trace = run('.mcp[$NAME] = $JSON+{"type":"stdio"}', {
      NAME: 'gh',
      JSON: STDIO_SPEC,
    })
    expect(trace.finalDoc).toEqual({
      mcp: { gh: { ...STDIO_SPEC, type: 'stdio' } },
    })
  })

  test('opencode: array-command form', () => {
    const expr =
      '.mcp[$NAME] = {"type":"local","command":[$JSON.command]+$JSON.args,"enabled":true}'
    const trace = run(expr, { NAME: 'gh', JSON: STDIO_SPEC })
    expect(trace.finalDoc).toEqual({
      mcp: {
        gh: {
          type: 'local',
          command: ['gh-mcp', 'serve'],
          enabled: true,
        },
      },
    })
  })

  test('continue.dev: pipe with null-coalesce and list append', () => {
    const expr =
      '.mcpServers = (.mcpServers // []) | .mcpServers += [{"name":$NAME}+$JSON]'
    const trace = run(expr, { NAME: 'gh', JSON: STDIO_SPEC })
    expect(trace.finalDoc).toEqual({
      mcpServers: [{ name: 'gh', ...STDIO_SPEC }],
    })
    // Should append (not overwrite) if the array already has entries.
    const trace2 = run(expr, { NAME: 'gh2', JSON: STDIO_SPEC }, trace.finalDoc)
    expect(
      (trace2.finalDoc as { mcpServers: unknown[] }).mcpServers,
    ).toHaveLength(2)
  })

  test('goose: block form with $SIMPLE_NAME + field renames + injects', () => {
    const expr = `.extensions[$SIMPLE_NAME] = {
      "args": $JSON.args,
      "bundled": null,
      "cmd": $JSON.command,
      "description": "managed",
      "enabled": true,
      "envs": $JSON.env,
      "timeout": 300,
      "type": "stdio"
    }`
    const trace = run(expr, {
      NAME: 'MCP_DOCKER',
      SIMPLE_NAME: 'mcpdocker',
      JSON: STDIO_SPEC,
    })
    expect(trace.finalDoc).toEqual({
      extensions: {
        mcpdocker: {
          args: ['serve'],
          bundled: null,
          cmd: 'gh-mcp',
          description: 'managed',
          enabled: true,
          envs: { KEY: 'val' },
          timeout: 300,
          type: 'stdio',
        },
      },
    })
  })
})

describe('yq: write trace records what and where', () => {
  test('single assign records the resolved path', () => {
    const trace = run('.mcpServers[$NAME] = $JSON', {
      NAME: 'gh',
      JSON: STDIO_SPEC,
    })
    expect(trace.writes).toHaveLength(1)
    expect(trace.writes[0]?.op).toBe('assign')
    expect(trace.writes[0]?.resolvedPath).toEqual(['mcpServers', 'gh'])
  })

  test('append records the appended item, not the whole array', () => {
    const expr = '.mcpServers += [{"name":$NAME}+$JSON]'
    const trace = run(
      expr,
      { NAME: 'gh', JSON: STDIO_SPEC },
      { mcpServers: [{ name: 'prev', command: 'x' }] },
    )
    expect(trace.writes[0]?.op).toBe('append')
    expect(trace.writes[0]?.written).toEqual({ name: 'gh', ...STDIO_SPEC })
    const doc = trace.finalDoc as { mcpServers: unknown[] }
    expect(doc.mcpServers).toHaveLength(2)
  })
})

describe('yq: fail-loud on unsupported constructs', () => {
  test('array indexing throws', () => {
    expect(() => run('.foo[0] = 1')).toThrow(YqError)
  })

  test('unknown operator throws at lex time', () => {
    expect(() => tokenize('.foo * 2')).toThrow(YqError)
  })

  test('trailing tokens after program throw', () => {
    expect(() => parse('.foo = 1 = 2')).toThrow(YqError)
  })
})
