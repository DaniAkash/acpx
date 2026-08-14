import { describe, expect, test } from 'bun:test'
import { translateNetworkPolicy } from '../../src/network-policy.ts'

describe('translateNetworkPolicy', () => {
  test('"allow-all" → default-allow, no rules', () => {
    const policy = translateNetworkPolicy({ mode: 'allow-all' })
    expect(policy.defaultEgress).toBe('allow')
    expect(policy.defaultIngress).toBe('allow')
    expect(policy.rules).toEqual([])
  })

  test('"deny-all" → default-deny, no rules', () => {
    const policy = translateNetworkPolicy({ mode: 'deny-all' })
    expect(policy.defaultEgress).toBe('deny')
    expect(policy.defaultIngress).toBe('deny')
    expect(policy.rules).toEqual([])
  })

  test('"custom" with empty allow/deny → bare deny-all', () => {
    const policy = translateNetworkPolicy({ mode: 'custom', allowedHosts: [] })
    expect(policy.defaultEgress).toBe('deny')
    expect(policy.rules).toEqual([])
  })

  test('"custom" with one allowed host → one allow rule', () => {
    const policy = translateNetworkPolicy({
      mode: 'custom',
      allowedHosts: ['api.example.com'],
    })
    expect(policy.rules).toHaveLength(1)
  })

  test('"custom" with multiple allowed hosts → one rule per host', () => {
    const policy = translateNetworkPolicy({
      mode: 'custom',
      allowedHosts: ['api.example.com', 'cdn.example.com', 'auth.example.com'],
    })
    expect(policy.rules).toHaveLength(3)
  })

  test('"custom" with allowed CIDRs → one rule per cidr', () => {
    const policy = translateNetworkPolicy({
      mode: 'custom',
      allowedCIDRs: ['10.0.0.0/8', '192.168.0.0/16'],
    })
    expect(policy.rules).toHaveLength(2)
  })

  test('"custom" with denied CIDRs → one rule per cidr', () => {
    const policy = translateNetworkPolicy({
      mode: 'custom',
      allowedCIDRs: ['10.0.0.0/8'],
      deniedCIDRs: ['10.1.2.0/24'],
    })
    expect(policy.rules).toHaveLength(2)
  })

  test('"custom" with all three lists → expected total rule count', () => {
    const policy = translateNetworkPolicy({
      mode: 'custom',
      allowedHosts: ['api.example.com', 'cdn.example.com'],
      allowedCIDRs: ['10.0.0.0/8'],
      deniedCIDRs: ['10.1.2.0/24', '169.254.169.254/32'],
    })
    // 2 deny cidrs + 2 hosts + 1 allow cidr = 5
    expect(policy.rules).toHaveLength(5)
  })

  test('rule order: deny rules emit BEFORE allow rules', () => {
    const policy = translateNetworkPolicy({
      mode: 'custom',
      allowedCIDRs: ['10.0.0.0/8'],
      deniedCIDRs: ['10.1.2.0/24'],
    })
    // Deny first, allow second. First-match-wins gives deniedCIDRs the
    // precedence the harness contract requires.
    expect(policy.rules[0]?.action).toBe('deny')
    expect(policy.rules[1]?.action).toBe('allow')
  })

  test('emits well-formed Rule/Destination objects', () => {
    const policy = translateNetworkPolicy({
      mode: 'custom',
      allowedHosts: ['api.example.com'],
      deniedCIDRs: ['169.254.169.254/32'],
    })
    expect(policy.rules[0]).toMatchObject({
      action: 'deny',
      direction: 'any',
      destination: { kind: 'cidr', cidr: '169.254.169.254/32' },
    })
    expect(policy.rules[1]).toMatchObject({
      action: 'allow',
      direction: 'any',
      destination: { kind: 'domainSuffix', suffix: 'api.example.com' },
    })
  })
})
