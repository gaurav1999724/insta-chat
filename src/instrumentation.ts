// Next.js's official hook for one-time server startup code — the
// documented place to start long-running background workers (BullMQ, in
// this app). Only runs in the Node.js runtime; the edge runtime can't run
// BullMQ (it needs `net`/`tls`), so it's explicitly skipped there.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startQueueWorkers } = await import("@/lib/queue/start-workers");
    startQueueWorkers();
  }
}
