import { redirect } from "next/navigation";

import { auth } from "@/lib/auth/auth";

export async function requireUser() {
  const session = await auth();

  if (!session?.user) {
    redirect("/sign-in");
  }

  return session.user;
}
