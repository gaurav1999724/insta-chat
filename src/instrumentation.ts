import { prisma } from "@/lib/db/prisma";
import { recoverUnansweredReplies } from "@/services/ai/unanswered-reply-recovery-service";

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

export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs" || recoveryTimer) return;

	recoveryTimer = setInterval(() => {
		void runRecoveryScan();
	}, RECOVERY_INTERVAL_MS);
}
