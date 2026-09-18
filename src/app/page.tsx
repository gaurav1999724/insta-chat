import Link from "next/link";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth/auth";

export default async function Home() {
  const session = await auth();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      <div className="space-y-3">
        <h1 className="text-4xl font-semibold tracking-tight">InstaMate AI</h1>
        <p className="max-w-md text-balance text-muted-foreground">
          Your personal AI assistant for managing Instagram conversations — natural
          Hinglish replies, your rules, your control.
        </p>
      </div>
      <Button asChild size="lg">
        <Link href={session ? "/dashboard" : "/sign-in"}>
          {session ? "Go to dashboard" : "Sign in"}
        </Link>
      </Button>
    </main>
  );
}
