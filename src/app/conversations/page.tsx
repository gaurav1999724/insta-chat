import { MessageCircle } from "lucide-react";

import { ConversationSidebar } from "@/components/conversations/conversation-sidebar";
import { requireUser } from "@/lib/auth/require-user";
import { parseStatusFilter } from "@/lib/conversations/get-conversation-list";

export default async function ConversationsIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const user = await requireUser();
  const { status: rawStatus, q: search } = await searchParams;
  const status = parseStatusFilter(rawStatus);

  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[300px_1fr]">
      <ConversationSidebar userId={user.id} status={status} search={search} />
      <main className="hidden flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground md:flex">
        <MessageCircle className="size-8" />
        Select a conversation to start chatting.
      </main>
    </div>
  );
}
