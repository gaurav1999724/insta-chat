import { AppShell } from "@/components/layout/app-shell";
import { requireUser } from "@/lib/auth/require-user";

export default async function ConversationsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  return (
    <AppShell userLabel={user.email ?? user.name ?? "Account"}>
      <div className="h-[calc(100vh-3.5rem)]">{children}</div>
    </AppShell>
  );
}
