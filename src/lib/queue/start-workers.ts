import { isQueueingConfigured } from "@/lib/queue/connection";
import { startAIResponseWorker } from "@/lib/queue/workers/ai-response-worker";
import { startInstagramSendWorker } from "@/lib/queue/workers/instagram-send-worker";
import { startMemoryExtractionWorker } from "@/lib/queue/workers/memory-extraction-worker";

let started = false;

// Called once from `src/instrumentation.ts` when the server boots. Guarded
// against being called more than once in the same process (Next.js's
// `register()` is documented to run once per server instance, but this is
// a cheap, harmless safeguard against creating duplicate Worker instances
// if that ever isn't true, e.g. under some dev-mode reload path).
export function startQueueWorkers(): void {
  if (started) return;
  started = true;

  if (!isQueueingConfigured()) {
    console.log(
      "[queue] REDIS_URL not set — automatic AI processing is disabled. " +
        "The manual 'AI Generate'/'Analyze conversation'/'Send' actions still work.",
    );
    return;
  }

  startAIResponseWorker();
  startInstagramSendWorker();
  startMemoryExtractionWorker();
  console.log("[queue] Workers started: ai-response, instagram-send, memory-extraction.");
}
