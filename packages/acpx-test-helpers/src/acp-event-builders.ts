import type {
  AcpRuntimeAvailableCommand,
  AcpRuntimeEvent,
  AcpRuntimeTurnResult,
  AcpRuntimeTurnResultError,
  AcpRuntimeUsageBreakdown,
  AcpRuntimeUsageCost,
  AcpSessionUpdateTag,
} from 'acpx/runtime'

type TextOpts = { tag?: AcpSessionUpdateTag }
type ToolCallOpts = {
  toolCallId: string
  text?: string
  title?: string
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | string
  tag?: AcpSessionUpdateTag
}
type StatusOpts = {
  text?: string
  tag?: AcpSessionUpdateTag
  used?: number
  size?: number
  cost?: AcpRuntimeUsageCost
  breakdown?: AcpRuntimeUsageBreakdown
  availableCommands?: AcpRuntimeAvailableCommand[]
}
type ErrorOpts = { code?: string; retryable?: boolean }

/** Compact builders for `AcpRuntimeEvent` values used in tests. */
export const acpEvent = {
  text(delta: string, opts: TextOpts = {}): AcpRuntimeEvent {
    return { type: 'text_delta', text: delta, stream: 'output', ...opts }
  },

  thought(delta: string, opts: TextOpts = {}): AcpRuntimeEvent {
    return { type: 'text_delta', text: delta, stream: 'thought', ...opts }
  },

  toolCall(opts: ToolCallOpts): AcpRuntimeEvent {
    return {
      type: 'tool_call',
      text: opts.text ?? '',
      toolCallId: opts.toolCallId,
      title: opts.title,
      status: opts.status,
      tag: opts.tag,
    }
  },

  status(opts: StatusOpts = {}): AcpRuntimeEvent {
    return {
      type: 'status',
      text: opts.text ?? '',
      tag: opts.tag,
      used: opts.used,
      size: opts.size,
      cost: opts.cost,
      breakdown: opts.breakdown,
      availableCommands: opts.availableCommands,
    }
  },

  usage(
    used: number,
    size?: number,
    extra: {
      cost?: AcpRuntimeUsageCost
      breakdown?: AcpRuntimeUsageBreakdown
    } = {},
  ): AcpRuntimeEvent {
    return acpEvent.status({ tag: 'usage_update', used, size, ...extra })
  },

  availableCommands(commands: AcpRuntimeAvailableCommand[]): AcpRuntimeEvent {
    return acpEvent.status({
      tag: 'available_commands_update',
      availableCommands: commands,
    })
  },

  plan(text: string): AcpRuntimeEvent {
    return acpEvent.status({ tag: 'plan', text })
  },

  done(stopReason?: string): AcpRuntimeEvent {
    return { type: 'done', stopReason }
  },

  error(message: string, opts: ErrorOpts = {}): AcpRuntimeEvent {
    return { type: 'error', message, ...opts }
  },
}

export const acpResult = {
  completed(stopReason: string = 'end_turn'): AcpRuntimeTurnResult {
    return { status: 'completed', stopReason }
  },

  cancelled(stopReason?: string): AcpRuntimeTurnResult {
    return { status: 'cancelled', stopReason }
  },

  failed(error: AcpRuntimeTurnResultError): AcpRuntimeTurnResult {
    return { status: 'failed', error }
  },
}
