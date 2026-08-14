import { describe, expect, test } from 'bun:test'
import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import type { BridgeTurn } from '@ai-sdk/harness/bridge'
import type { AcpPermissionDecision, AcpPermissionRequest } from 'acpx/runtime'
import { createPermissionHandler } from '../../src/bridge/permission-handler.ts'

interface PendingApproval {
  approvalId: string
  resolve: (value: { approved: boolean; reason?: string }) => void
  reject: (reason: unknown) => void
}

function makeFakeTurn(): {
  turn: BridgeTurn
  emitted: HarnessV1StreamPart[]
  pending: PendingApproval[]
  abort: () => void
} {
  const emitted: HarnessV1StreamPart[] = []
  const pending: PendingApproval[] = []
  const controller = new AbortController()
  const turn: BridgeTurn = {
    emit: (event) => {
      emitted.push(event as HarnessV1StreamPart)
    },
    requestToolResult: async () => ({ output: null }),
    requestToolApproval: (approvalId) => {
      return new Promise<{ approved: boolean; reason?: string }>(
        (resolve, reject) => {
          pending.push({ approvalId, resolve, reject })
        },
      )
    },
    pendingUserMessages: [],
    abortSignal: controller.signal,
    firstTurn: true,
    bridgeLog: () => {},
    emitWarning: () => {},
    emitError: () => {},
  }
  return { turn, emitted, pending, abort: () => controller.abort() }
}

function makeRequest(toolCallId: string): AcpPermissionRequest {
  return {
    sessionId: 'sess-1',
    inferredKind: 'execute',
    raw: {
      sessionId: 'sess-1',
      toolCall: { toolCallId, status: 'pending', title: 'Bash' },
      options: [],
    } as unknown as AcpPermissionRequest['raw'],
  }
}

describe('createPermissionHandler', () => {
  test('emits a tool-approval-request when acpx asks for permission', async () => {
    const { turn, emitted, pending } = makeFakeTurn()
    const handler = createPermissionHandler(turn)
    const promise = handler(makeRequest('call-1'), {
      signal: new AbortController().signal,
    })

    // After invocation, the bridge should have emitted exactly one approval
    // request that ties the approval to the same toolCallId.
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual({
      type: 'tool-approval-request',
      approvalId: 'call-1',
      toolCallId: 'call-1',
    })
    expect(pending[0]?.approvalId).toBe('call-1')

    // Resolve the pending approval; the handler should now produce an acpx
    // decision.
    pending[0]?.resolve({ approved: true })
    const decision = await promise
    expect(decision).toEqual({
      outcome: 'allow_once',
    } satisfies AcpPermissionDecision)
  })

  test('approved=false maps to reject_once', async () => {
    const { turn, pending } = makeFakeTurn()
    const handler = createPermissionHandler(turn)
    const promise = handler(makeRequest('call-2'), {
      signal: new AbortController().signal,
    })
    pending[0]?.resolve({ approved: false, reason: 'too risky' })
    const decision = await promise
    expect(decision).toEqual({
      outcome: 'reject_once',
    } satisfies AcpPermissionDecision)
  })

  test('an aborted context resolves to undefined (falls through to permissionMode)', async () => {
    const { turn } = makeFakeTurn()
    const handler = createPermissionHandler(turn)
    const requestCtl = new AbortController()
    const promise = handler(makeRequest('call-3'), {
      signal: requestCtl.signal,
    })
    requestCtl.abort()
    const decision = await promise
    expect(decision).toBeUndefined()
  })

  test('a pre-aborted signal short-circuits before requesting approval', async () => {
    const { turn, emitted, pending } = makeFakeTurn()
    const handler = createPermissionHandler(turn)
    const requestCtl = new AbortController()
    requestCtl.abort()
    const decision = await handler(makeRequest('call-4'), {
      signal: requestCtl.signal,
    })
    expect(decision).toBeUndefined()
    // No approval request emitted, no requestToolApproval invocation queued.
    expect(emitted).toEqual([])
    expect(pending).toEqual([])
  })

  test('removes the abort listener once approval resolves', async () => {
    const { turn, pending } = makeFakeTurn()
    const handler = createPermissionHandler(turn)
    const requestCtl = new AbortController()
    let listenerCount = 0
    const origAdd = requestCtl.signal.addEventListener.bind(requestCtl.signal)
    const origRemove = requestCtl.signal.removeEventListener.bind(
      requestCtl.signal,
    )
    requestCtl.signal.addEventListener = ((
      ...args: Parameters<typeof origAdd>
    ) => {
      listenerCount++
      return origAdd(...args)
    }) as typeof origAdd
    requestCtl.signal.removeEventListener = ((
      ...args: Parameters<typeof origRemove>
    ) => {
      listenerCount--
      return origRemove(...args)
    }) as typeof origRemove

    const promise = handler(makeRequest('call-5'), {
      signal: requestCtl.signal,
    })
    pending[0]?.resolve({ approved: true })
    await promise
    expect(listenerCount).toBe(0)
  })
})
