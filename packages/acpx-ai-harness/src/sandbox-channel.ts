import type {
  HarnessV1BridgeOutboundMessage,
  HarnessV1NetworkSandboxSession,
} from '@ai-sdk/harness'
import { harnessV1BridgeOutboundMessageSchema } from '@ai-sdk/harness'
import { SandboxChannel } from '@ai-sdk/harness/utils'
import { WebSocket } from 'ws'
import type { AcpxBridgeStartMessage } from './acpx-bridge-protocol.ts'

/**
 * Inbound (host -> bridge) message union for acpx. Mirrors the reference
 * adapter pattern: an adapter-specific `start` extension plus the standard
 * harness inbound control frames the bridge knows how to parse.
 */
export type AcpxBridgeInboundMessage =
  | AcpxBridgeStartMessage
  | {
      type: 'tool-result'
      toolCallId: string
      output: unknown
      isError?: boolean
    }
  | {
      type: 'tool-approval-response'
      approvalId: string
      approved: boolean
      reason?: string
    }
  | { type: 'user-message'; text: string }
  | { type: 'abort' }
  | { type: 'destroy' }
  | { type: 'stop' }
  | { type: 'resume'; lastSeenEventId: number }

/** Channel typed against the acpx outbound + inbound wire shapes. */
export type AcpxChannel = SandboxChannel<
  HarnessV1BridgeOutboundMessage,
  AcpxBridgeInboundMessage
>

export interface OpenAcpxChannelOptions {
  readonly sandboxSession: HarnessV1NetworkSandboxSession
  readonly port: number
  /** Per-bridge auth token; appended to the URL as `agent_bridge_token`. */
  readonly token: string
  /** When set, seeds the resume cursor for cross-process attach. */
  readonly initialLastSeenEventId?: number
}

/** How long `openAcpxChannel` waits for `bridge-hello` after the WS opens. */
const BRIDGE_HELLO_TIMEOUT_MS = 30_000

/**
 * Open a channel and synchronise with the bridge's handshake before
 * resolving. The bridge sends `bridge-hello` on every fresh WS connection
 * to signal "I'm ready to accept commands"; sending a `start` frame
 * before that arrives gets the frame silently dropped, which the host
 * then experiences as a forever-hanging stream.
 *
 * Use this instead of calling `channel.open()` directly when the next
 * thing you do is `channel.send(...)`.
 */
export async function openAcpxChannel(
  channel: AcpxChannel,
  opts?: { resume?: boolean; helloTimeoutMs?: number },
): Promise<void> {
  let resolveHello!: () => void
  let rejectHello!: (err: unknown) => void
  const helloP = new Promise<void>((resolve, reject) => {
    resolveHello = resolve
    rejectHello = reject
  })
  // SandboxChannel buffers inbound messages until a listener is registered,
  // so subscribing after open() is safe: the first replayed message will
  // be bridge-hello.
  const unsub = channel.on('bridge-hello' as never, () => {
    unsub()
    resolveHello()
  })
  const timer = setTimeout(() => {
    unsub()
    rejectHello(
      new Error(
        `acpx-ai-harness: bridge did not send bridge-hello within ${
          opts?.helloTimeoutMs ?? BRIDGE_HELLO_TIMEOUT_MS
        }ms after WebSocket connect. The bridge process may have died after the WS handshake; check its stderr.`,
      ),
    )
  }, opts?.helloTimeoutMs ?? BRIDGE_HELLO_TIMEOUT_MS)
  try {
    await channel.open(opts?.resume ? { resume: true } : undefined)
    await helloP
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Build (but don't yet open) a SandboxChannel pointed at the in-sandbox
 * bridge's WebSocket endpoint. The caller decides whether to open fresh
 * (`channel.open()`) or resume against a buffered log
 * (`channel.open({ resume: true })`). Prefer `openAcpxChannel(channel)`
 * over `channel.open()` directly so the handshake is honoured before
 * subsequent sends.
 *
 * The connect thunk re-resolves the URL on every reconnect so transient
 * sandbox-side port re-binds are tolerated by the channel's auto-reconnect
 * loop.
 */
export function createAcpxChannel(opts: OpenAcpxChannelOptions): AcpxChannel {
  const connect = async (): Promise<WebSocket> => {
    const base = await opts.sandboxSession.getPortUrl({
      port: opts.port,
      protocol: 'ws',
    })
    const url = `${base}?agent_bridge_token=${encodeURIComponent(opts.token)}`
    return new WebSocket(url)
  }

  return new SandboxChannel<
    HarnessV1BridgeOutboundMessage,
    AcpxBridgeInboundMessage
  >({
    connect,
    outboundSchema: harnessV1BridgeOutboundMessageSchema,
    ...(opts.initialLastSeenEventId !== undefined
      ? { initialLastSeenEventId: opts.initialLastSeenEventId }
      : {}),
  })
}
