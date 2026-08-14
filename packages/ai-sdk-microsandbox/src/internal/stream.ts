import type { ExecEvent } from 'microsandbox'

/**
 * Drain a `ReadableStream<Uint8Array>` into a single byte buffer. Honors
 * `abortSignal` between chunks — if abort fires mid-drain we cancel the
 * source stream and throw `signal.reason`, rather than waiting for the
 * entire upload to finish.
 */
export async function collectStream(
  stream: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
): Promise<Uint8Array> {
  abortSignal?.throwIfAborted()
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      abortSignal?.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.byteLength
      }
    }
  } catch (error) {
    // Best-effort: tell the source we're not reading anymore so it can release
    // resources. Swallow cancel errors; the original error is what matters.
    reader.cancel(error).catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Wrap raw bytes in a one-shot `ReadableStream<Uint8Array>`. */
export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Demultiplex a microsandbox `ExecHandle`'s combined event stream into two
 * independent `ReadableStream<Uint8Array>`s (stdout, stderr) plus an
 * `exitCode` promise.
 *
 * microsandbox's `ExecHandle` couples its async iterator and `handle.wait()`
 * to one native stream: once the iterator reaches the terminal `exited` event
 * (which it does as soon as the consumer drains stdout), a separate
 * `handle.wait()` starves and throws "exec session ended without exit event".
 * So the exit code is observed HERE, where the iterator is the single
 * consumer, and handed back via `exitCode` instead of a competing `wait()`.
 *
 * The event stream is drained eagerly (not gated on the stdout reader) so the
 * `exited` event is always observed even when the consumer never reads stdout;
 * that trades ReadableStream backpressure for reliable exit detection, which is
 * the right call for the bounded, promptly-read output of an agent turn.
 */
export function demuxExecStreams(
  source: AsyncIterable<ExecEvent>,
  onPid?: (pid: number) => void,
): {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exitCode: Promise<number>
} {
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined
  let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined

  // start() runs synchronously during construction, so both controllers are
  // assigned before the pump below reads them.
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      stdoutController = c
    },
  })
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      stderrController = c
    },
  })

  let settleExit: (code: number) => void = () => {}
  let failExit: (error: unknown) => void = () => {}
  const exitCode = new Promise<number>((resolve, reject) => {
    settleExit = resolve
    failExit = reject
  })
  // Never let an unawaited `exitCode` (e.g. caller only reads stdout) surface
  // as an unhandled rejection.
  exitCode.catch(() => {})

  void (async () => {
    let sawExit = false
    try {
      for await (const event of source) {
        switch (event.kind) {
          case 'started':
            onPid?.(event.pid)
            break
          case 'stdout':
            stdoutController?.enqueue(event.data)
            break
          case 'stderr':
            stderrController?.enqueue(event.data)
            break
          case 'exited':
            sawExit = true
            settleExit(event.code)
            break
        }
      }
      stdoutController?.close()
      stderrController?.close()
      if (!sawExit) {
        failExit(
          new Error('microsandbox exec stream ended without an exited event'),
        )
      }
    } catch (error) {
      stdoutController?.error(error)
      stderrController?.error(error)
      if (!sawExit) failExit(error)
    }
  })()

  return { stdout, stderr, exitCode }
}
