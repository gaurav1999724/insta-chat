import { prisma } from "@/lib/db/prisma";
import { recoverUnansweredReplies } from "@/services/ai/unanswered-reply-recovery-service";
import { retryDueFailedDeliveries } from "@/services/ai/retry-service";

const RECOVERY_INTERVAL_MS = 10_000;
const RECOVERY_LOCK_KEY = "instamate-unanswered-reply-recovery";

let recoveryTimer: ReturnType<typeof setInterval> | undefined;
let recoveryScanInProgress = false;

async function runRecoveryScan(): Promise<void> {
	if (recoveryScanInProgress) return;
	recoveryScanInProgress = true;

	try {
		const [{ locked }] = await prisma.$queryRaw<{ locked: boolean }[]>`
			SELECT pg_try_advisory_lock(hashtext(${RECOVERY_LOCK_KEY})) AS locked
		`;
		if (!locked) return;

		try {
			await recoverUnansweredReplies();
		} finally {
			await prisma.$queryRaw`
				SELECT pg_advisory_unlock(hashtext(${RECOVERY_LOCK_KEY}))
			`;
		}
	} catch {
		// Recovery is best effort; webhook and manual flows remain available.
	} finally {
		recoveryScanInProgress = false;
	}
}

// Same "no cron job" approach as the recovery scan above, for retrying a
// previously FAILED reply send (see src/services/ai/retry-service.ts and
// src/lib/instagram/retry-policy.ts for the backoff schedule). A separate,
// longer interval than the recovery scan: the earliest a retry is ever due
// is 1 minute after its failure, so checking every 10s would just be wasted
// queries.
const RETRY_SWEEP_INTERVAL_MS = 60_000;
const RETRY_SWEEP_LOCK_KEY = "instamate-retry-failed-deliveries";

let retrySweepTimer: ReturnType<typeof setInterval> | undefined;
let retrySweepInProgress = false;

async function runRetrySweep(): Promise<void> {
	if (retrySweepInProgress) return;
	retrySweepInProgress = true;

	try {
		const [{ locked }] = await prisma.$queryRaw<{ locked: boolean }[]>`
			SELECT pg_try_advisory_lock(hashtext(${RETRY_SWEEP_LOCK_KEY})) AS locked
		`;
		if (!locked) return;

		try {
			await retryDueFailedDeliveries();
		} finally {
			await prisma.$queryRaw`
				SELECT pg_advisory_unlock(hashtext(${RETRY_SWEEP_LOCK_KEY}))
			`;
		}
	} catch {
		// Best effort — the per-conversation opportunistic retry (triggered
		// from the webhook route on the next inbound message) and manual
		// resend remain available regardless.
	} finally {
		retrySweepInProgress = false;
	}
}

export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;

	if (!recoveryTimer) {
		recoveryTimer = setInterval(() => {
			void runRecoveryScan();
		}, RECOVERY_INTERVAL_MS);
	}

	if (!retrySweepTimer) {
		retrySweepTimer = setInterval(() => {
			void runRetrySweep();
		}, RETRY_SWEEP_INTERVAL_MS);
	}
}
