import type { Experimental_SandboxProcess } from '@ai-sdk/provider-utils'
import type { ExecHandle } from 'microsandbox'
import { demuxExecStreams } from './internal/stream.ts'

/**
 * Adapt microsandbox's `ExecHandle` to the harness's `SandboxProcess` shape.
 * Demultiplexes the combined event stream into separate stdout/stderr
 * ReadableStreams and wires the abort signal to `handle.kill()` — the one
 * code path where signal propagation is real rather than best-effort.
 */
export function createSandboxProcess(
  handle: ExecHandle,
  abortSignal: AbortSignal | undefined,
): Experimental_SandboxProcess {
  let pid: number | undefined
  const { stdout, stderr, exitCode } = demuxExecStreams(
    handle,
    (resolvedPid) => {
      pid = resolvedPid
    },
  )

  // The exit code comes from the demux (the single consumer of the handle's
  // event stream), not `handle.wait()`, which would starve once the demux
  // observes the terminal `exited` event. On abort we resolve `wait()`
  // ourselves with the canonical SIGKILL exit code (128 + 9), since a killed
  // exec may tear its stream down before delivering an `exited` event.
  let resolveAborted: ((value: { exitCode: number }) => void) | undefined
  const aborted = new Promise<{ exitCode: number }>((res) => {
    resolveAborted = res
  })

  const cancelProcess = (): void => {
    // SIGKILL via signal(9) when available; fall back to kill() for
    // SDK revs or test doubles that don't expose signal().
    const sig = (handle as { signal?: (n: number) => Promise<void> }).signal
    if (typeof sig === 'function') {
      sig.call(handle, 9).catch(() => handle.kill().catch(() => undefined))
    } else {
      handle.kill().catch(() => undefined)
    }
    resolveAborted?.({ exitCode: 137 })
  }
  if (abortSignal && !abortSignal.aborted) {
    abortSignal.addEventListener('abort', cancelProcess, { once: true })
  } else if (abortSignal?.aborted) {
    cancelProcess()
  }
  return {
    get pid() {
      return pid
    },
    stdout,
    stderr,
    async wait() {
      return await Promise.race([
        exitCode.then((code) => ({ exitCode: code })),
        aborted,
      ])
    },
    async kill() {
      await handle.kill()
    },
  }
}
