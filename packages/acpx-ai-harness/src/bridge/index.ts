import { runBridge } from '@ai-sdk/harness/bridge'
import type { AcpxBridgeStartMessage } from '../acpx-bridge-protocol.ts'
import { runAcpxTurn } from './run-turn.ts'

/**
 * Entry point for the in-sandbox bridge process.
 *
 * Spawned by the host with `--workdir <path> --bridge-state-dir <path>` and
 * the environment variables `BRIDGE_CHANNEL_TOKEN` / `BRIDGE_WS_PORT` that
 * `@ai-sdk/harness/bridge` reads internally. Boots a WebSocket server and
 * services one prompt turn per `start` frame from the host.
 */

function parseArgs(argv: ReadonlyArray<string>): {
  workdir?: string
  bridgeStateDir?: string
} {
  const out: { workdir?: string; bridgeStateDir?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    // Treat the next flag as "no value" so a typo like
    // `--workdir --bridge-state-dir foo` errors loudly via the
    // missing-arg check below instead of silently mis-assigning.
    if (!value || value.startsWith('--')) continue
    if (flag === '--workdir') {
      out.workdir = value
      i++
    } else if (flag === '--bridge-state-dir') {
      out.bridgeStateDir = value
      i++
    }
  }
  return out
}

function emitFatal(message: string): never {
  process.stderr.write(`acpx-ai-harness bridge: ${message}\n`)
  process.exit(1)
}

const args = parseArgs(process.argv.slice(2))
if (!args.workdir) emitFatal('Missing --workdir argument.')
if (!args.bridgeStateDir) emitFatal('Missing --bridge-state-dir argument.')

const workdir = args.workdir
const bridgeStateDir = args.bridgeStateDir

await runBridge<AcpxBridgeStartMessage>({
  bridgeType: 'acpx',
  bridgeStateDir,
  onStart: (start, turn) => runAcpxTurn(start, turn, { workdir }),
  onStop: () => ({}),
})
