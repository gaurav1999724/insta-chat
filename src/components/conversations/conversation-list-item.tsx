import Link from "next/link";
import { Bot, UserCog } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { ConversationListItem } from "@/lib/conversations/get-conversation-list";

function formatTimestamp(date: Date | null) {
  if (!date) return "";
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ConversationListItemLink({
  conversation,
  href,
  active,
}: {
  conversation: ConversationListItem;
  href: string;
  active: boolean;
}) {
  const displayName =
    conversation.participant.displayName ??
    conversation.participant.username ??
    "Unknown contact";
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <Link
      href={href}
      className={cn(
        "flex items-start gap-3 border-b px-3 py-3 text-sm hover:bg-accent",
        active && "bg-accent",
      )}
    >
      <Avatar>
        {conversation.participant.profilePictureUrl && (
          <AvatarImage
            src={conversation.participant.profilePictureUrl}
            alt={displayName}
          />
        )}
        <AvatarFallback>{initial}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn("truncate font-medium", conversation.unread && "font-semibold")}
          >
            {displayName}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatTimestamp(conversation.lastMessageAt)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p
            className={cn(
              "truncate text-xs text-muted-foreground",
              conversation.unread && "font-medium text-foreground",
            )}
          >
            {conversation.latestMessage?.text ?? "No messages yet"}
          </p>
          {conversation.unread && (
            <span
              className="size-2 shrink-0 rounded-full bg-primary"
              aria-label="Unread"
            />
          )}
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          {conversation.aiEnabled && (
            <span className="flex items-center gap-1">
              <Bot className="size-3" /> AI
            </span>
          )}
          {conversation.humanTakeover && (
            <span className="flex items-center gap-1">
              <UserCog className="size-3" /> Human
            </span>
          )}
          {conversation.chatModeName && <span>{conversation.chatModeName}</span>}
        </div>
      </div>
    </Link>
  );
}
