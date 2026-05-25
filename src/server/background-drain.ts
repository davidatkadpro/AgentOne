/**
 * The HTTP layer returns `{ ok: true }` from `POST /sessions/:id/message`
 * (and similar routes) *before* the orchestrator finishes the turn. The
 * route fires-and-forgets a generator drain so the orchestrator's
 * finally-block runs (persisting the assistant turn, emitting completion
 * events). Without explicit error handling, any provider/runtime failure
 * during the drain becomes an unhandled rejection — under strict Node
 * settings it can crash the process, and either way the UI never learns
 * the turn failed.
 *
 * `runTurnInBackground` wraps the drain so failures surface as a single
 * `turn.failed` event on the bus. The UI subscribes to that and renders
 * an error chip on the in-flight turn.
 */

import type { EventBus } from '../core/events.js'

export interface BackgroundTurnDeps {
  bus: EventBus
  /** Optional injection point so tests can capture the log line instead of
   *  printing to stderr. Defaults to `console.error`. */
  log?: (message: string) => void
}

async function drain(stream: AsyncIterable<string>): Promise<void> {
  // Iterating drives the orchestrator's generator past completion so its
  // finally-block runs (persists the assistant turn). We discard the
  // deltas — observers see them via the event bus.
  for await (const _ of stream) void _
}

export function runTurnInBackground(
  deps: BackgroundTurnDeps,
  sessionId: string,
  stream: AsyncIterable<string>,
): void {
  void drain(stream).catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    const log = deps.log ?? ((m: string) => {
      // eslint-disable-next-line no-console
      console.error(m)
    })
    log(`[turn ${sessionId}] background drain failed: ${message}`)
    void deps.bus.emit({
      type: 'turn.failed',
      sessionId,
      source: 'provider',
      message,
      ts: Date.now(),
    })
  })
}
