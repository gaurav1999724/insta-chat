import { env } from "@/lib/validation/env";
import { logOperation } from "@/lib/logging/logger";
import { retryDueFailedDeliveries } from "@/services/ai/retry-service";

// Scheduled via vercel.json's `crons` entry. Vercel signs cron-triggered
// requests with `Authorization: Bearer $CRON_SECRET` — reject anything else
// so this endpoint can't be used to force retries (or, incidentally, a
// batch of real Instagram sends) from the outside.
function isAuthorized(request: Request): boolean {
  if (!env.CRON_SECRET) return false;
  return request.headers.get("authorization") === `Bearer ${env.CRON_SECRET}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await retryDueFailedDeliveries();

  logOperation({
    operation: "cron.retry_failed_deliveries",
    status: "success",
    errorCode: `attempted_${result.attempted}_sent_${result.sent}`,
  });

  return Response.json(result);
}
