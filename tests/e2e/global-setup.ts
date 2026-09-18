import { randomBytes } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

import { PrismaClient } from "@prisma/client";

export const STORAGE_STATE_PATH = path.join(__dirname, ".auth", "demo-user.json");

// spec §68 full-flow E2E needs a signed-in session. Auth.js's real flow
// (email magic link) has no inbox to click from in a headless run, so this
// creates a `Session` row directly against the real database — the same
// row Auth.js's Prisma adapter would create after a real magic-link click
// — and hands Playwright a matching `authjs.session-token` cookie via
// storageState. No test-only HTTP route is added to the app itself, so
// there's no new sign-in surface to secure in production.
export default async function globalSetup() {
  const prisma = new PrismaClient();

  const user = await prisma.user.findUnique({
    where: { email: "demo@instamate.local" },
    select: { id: true },
  });

  if (!user) {
    await prisma.$disconnect();
    throw new Error(
      "Demo user not found — run `npm run prisma:seed` against DATABASE_URL first.",
    );
  }

  const sessionToken = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires },
  });

  await prisma.$disconnect();

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
  const domain = new URL(baseURL).hostname;

  mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });
  writeFileSync(
    STORAGE_STATE_PATH,
    JSON.stringify({
      cookies: [
        {
          name: "authjs.session-token",
          value: sessionToken,
          domain,
          path: "/",
          expires: Math.floor(expires.getTime() / 1000),
          httpOnly: true,
          secure: false,
          sameSite: "Lax" as const,
        },
      ],
      origins: [],
    }),
  );
}
