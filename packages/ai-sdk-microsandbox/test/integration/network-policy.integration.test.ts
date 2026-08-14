import { afterAll, expect, test } from 'bun:test'
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'
import { createMicrosandbox } from '../../src/microsandbox-provider.ts'
import {
  DEFAULT_INTEGRATION_IMAGE,
  INTEGRATION_TEST_TIMEOUT_MS,
  requireIntegrationEnv,
} from './_setup.ts'

const describeIntegration = requireIntegrationEnv()

/**
 * Probe TCP reachability using bash's `/dev/tcp` virtual device. Works on
 * the slim debian image without curl or wget. Returns true when the host:port
 * was reachable within ~5s.
 */
async function tcpProbe(
  session: HarnessV1NetworkSandboxSession,
  host: string,
  port: number,
): Promise<boolean> {
  const { exitCode } = await session.run({
    command: `timeout 5 bash -c 'echo > /dev/tcp/${host}/${port}' 2>/dev/null`,
  })
  return exitCode === 0
}

describeIntegration('microsandbox: network policy enforcement', () => {
  const sessions: HarnessV1NetworkSandboxSession[] = []

  afterAll(async () => {
    for (const s of sessions) {
      if (!s.destroy) continue
      try {
        await s.destroy()
      } catch {
        // Best-effort cleanup.
      }
    }
  }, INTEGRATION_TEST_TIMEOUT_MS)

  test(
    'allow-all policy permits outbound TCP',
    async () => {
      const provider = createMicrosandbox({
        image: DEFAULT_INTEGRATION_IMAGE,
        networkPolicy: { mode: 'allow-all' },
      })
      const session = await provider.createSession()
      sessions.push(session)
      const reachable = await tcpProbe(session, 'example.com', 443)
      expect(reachable).toBe(true)
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  )

  test(
    'deny-all policy blocks outbound TCP',
    async () => {
      const provider = createMicrosandbox({
        image: DEFAULT_INTEGRATION_IMAGE,
        networkPolicy: { mode: 'deny-all' },
      })
      const session = await provider.createSession()
      sessions.push(session)
      const reachable = await tcpProbe(session, 'example.com', 443)
      expect(reachable).toBe(false)
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  )

  test(
    'custom + allowedHosts permits listed host, blocks unlisted host',
    async () => {
      const provider = createMicrosandbox({
        image: DEFAULT_INTEGRATION_IMAGE,
        networkPolicy: {
          mode: 'custom',
          allowedHosts: ['example.com'],
        },
      })
      const session = await provider.createSession()
      sessions.push(session)
      const allowed = await tcpProbe(session, 'example.com', 443)
      const denied = await tcpProbe(session, 'iana.org', 443)
      expect(allowed).toBe(true)
      expect(denied).toBe(false)
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  )

  test(
    'deniedCIDRs override an overlapping allowedCIDRs entry (deny wins)',
    async () => {
      // Microsandbox 0.6.x evaluates rules first-match-wins per direction, and
      // the translation emits deniedCIDRs before allowedCIDRs, so a specific
      // deny short-circuits a broad allow covering the same address.
      //
      // Note: this precedence holds only WITHIN the CIDR layer. A CIDR deny
      // cannot veto a domain `allowedHosts` entry — 0.6.x matches domain rules
      // and CIDR rules against different connection-addressing modes, so the
      // two never conflict. The allowlist enforcement that actually matters
      // (allow listed host, block unlisted) is covered by the test above.
      const target = '1.1.1.1' // stable public anycast, inside 1.0.0.0/8
      const provider = createMicrosandbox({
        image: DEFAULT_INTEGRATION_IMAGE,
        networkPolicy: {
          mode: 'custom',
          allowedCIDRs: ['1.0.0.0/8'],
          deniedCIDRs: ['1.1.1.1/32'],
        },
      })
      const session = await provider.createSession()
      sessions.push(session)
      const reachable = await tcpProbe(session, target, 443)
      expect(reachable).toBe(false)
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  )
})
