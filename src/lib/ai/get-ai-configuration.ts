import { prisma } from "@/lib/db/prisma";

// The Auth.js `createUser` event (see `lib/auth/auth.ts`) seeds this row for
// every new sign-up. This upsert only exists to backfill it defensively for
// any user that predates that hook.
export function getOrCreateAIConfiguration(userId: string) {
  return prisma.aIConfiguration.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
}
