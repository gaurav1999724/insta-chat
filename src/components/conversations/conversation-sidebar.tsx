import { ConversationFilters } from "@/components/conversations/conversation-filters";
import { ConversationListItemLink } from "@/components/conversations/conversation-list-item";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  getConversationList,
  type ConversationStatusFilter,
} from "@/lib/conversations/get-conversation-list";

// Layouts can't read `searchParams` (only pages can, per Next.js's App
// Router contract), and the list depends on the status/search query
// params — so this lives in a shared component both `page.tsx` and
// `[conversationId]/page.tsx` render themselves, rather than in a layout.
export async function ConversationSidebar({
  userId,
  status,
  search,
  activeConversationId,
}: {
  userId: string;
  status: ConversationStatusFilter;
  search?: string;
  activeConversationId?: string;
}) {
  const conversations = await getConversationList(userId, { status, search });

  return (
    <aside className="hidden border-r md:flex md:flex-col">
      <div className="border-b p-3">
        <h2 className="text-sm font-semibold">Conversations</h2>
      </div>
      <ConversationFilters status={status} search={search} />
      <ScrollArea className="flex-1">
        {conversations.length === 0 ? (
          <div className="flex h-32 items-center justify-center px-4 text-center text-sm text-muted-foreground">
            {search || status !== "all"
              ? "No conversations match this filter."
              : "No conversations yet. Connect Instagram in Settings to sync conversations."}
          </div>
        ) : (
          conversations.map((conversation) => (
            <ConversationListItemLink
              key={conversation.id}
              conversation={conversation}
              href={`/conversations/${conversation.id}`}
              active={conversation.id === activeConversationId}
            />
          ))
        )}
      </ScrollArea>
    </aside>
  );
}
