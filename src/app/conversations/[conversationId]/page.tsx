import { notFound } from "next/navigation";

import { ConversationSettingsPanel } from "@/components/conversations/conversation-settings-panel";
import { ConversationSidebar } from "@/components/conversations/conversation-sidebar";
import { MessageBubble } from "@/components/conversations/message-bubble";
import { MessageComposer } from "@/components/conversations/message-composer";
import { ScrollArea } from "@/components/ui/scroll-area";
import { requireUser } from "@/lib/auth/require-user";
import { prisma } from "@/lib/db/prisma";
import { parseStatusFilter } from "@/lib/conversations/get-conversation-list";

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ conversationId: string }>;
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const user = await requireUser();
  const { conversationId } = await params;
  const { status: rawStatus, q: search } = await searchParams;
  const status = parseStatusFilter(rawStatus);

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, instagramAccount: { userId: user.id } },
    include: {
      participant: {
        select: { username: true, displayName: true, profilePictureUrl: true },
      },
      settings: true,
      messages: {
        orderBy: { createdAt: "asc" },
        include: { delivery: { select: { status: true } } },
      },
    },
  });

  if (!conversation) {
    notFound();
  }

  const [chatModes, pendingDraft, memories] = await Promise.all([
    prisma.chatMode.findMany({
      where: { OR: [{ userId: null }, { userId: user.id }] },
      orderBy: [{ isBuiltIn: "desc" }, { name: "asc" }],
      select: { id: true, name: true, isBuiltIn: true },
    }),
    prisma.aIResponse.findFirst({
      where: {
        conversationId: conversation.id,
        status: { in: ["PENDING_APPROVAL", "APPROVED"] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, text: true, confidence: true, status: true },
    }),
    prisma.conversationMemory.findMany({
      where: { conversationId: conversation.id },
      orderBy: [{ category: "asc" }, { key: "asc" }],
      select: { id: true, category: true, key: true, value: true, confidence: true },
    }),
  ]);

  // Best-effort read-tracking (spec §33 "unread indicator") — viewing the
  // thread marks it read. Not gating anything on the result of this write.
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastReadAt: new Date() },
  });

  const displayName =
    conversation.participant.displayName ??
    conversation.participant.username ??
    "Unknown contact";

  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[300px_1fr]">
      <ConversationSidebar
        userId={user.id}
        status={status}
        search={search}
        activeConversationId={conversationId}
      />
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px]">
        <main className="flex flex-col">
          <div className="flex items-center justify-between border-b p-3">
            <div>
              <p className="text-sm font-semibold">{displayName}</p>
              <p className="text-xs text-muted-foreground">
                {conversation.aiEnabled ? "AI enabled" : "AI paused"}
                {conversation.humanTakeover ? " · Human takeover" : ""}
              </p>
            </div>
          </div>

          <ScrollArea className="flex-1 p-4">
            <div className="space-y-2">
              {conversation.messages.length === 0 ? (
                <p className="text-center text-sm text-muted-foreground">
                  No messages yet.
                </p>
              ) : (
                conversation.messages.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))
              )}
            </div>
          </ScrollArea>

          <div className="border-t p-3">
            <MessageComposer
              conversationId={conversation.id}
              initialDraft={
                pendingDraft
                  ? {
                      aiResponseId: pendingDraft.id,
                      text: pendingDraft.text,
                      confidence: pendingDraft.confidence,
                      status: pendingDraft.status as "PENDING_APPROVAL" | "APPROVED",
                    }
                  : null
              }
            />
          </div>
        </main>

        <aside className="hidden border-l lg:block">
          <div className="border-b p-3">
            <h2 className="text-sm font-semibold">Conversation settings</h2>
          </div>
          <ScrollArea className="h-[calc(100%-2.75rem)]">
            <ConversationSettingsPanel
              conversationId={conversation.id}
              initialAiEnabled={conversation.aiEnabled}
              initialHumanTakeover={conversation.humanTakeover}
              initialChatModeId={conversation.chatModeId}
              chatModes={chatModes}
              contact={conversation.participant}
              initialProfile={{
                preferredName: conversation.settings?.preferredName ?? "",
                relationshipLabel: conversation.settings?.relationshipLabel ?? "",
                notes: conversation.settings?.notes ?? "",
              }}
              initialAISettings={{
                language: conversation.settings?.language ?? null,
                responseLength: conversation.settings?.responseLength ?? null,
                emojiLevel: conversation.settings?.emojiLevel ?? null,
                memoryEnabled: conversation.settings?.memoryEnabled ?? null,
                autoSend: conversation.settings?.autoSend ?? null,
                customInstructions: conversation.settings?.customInstructions ?? "",
              }}
              memories={memories}
            />
          </ScrollArea>
        </aside>
      </div>
    </div>
  );
}
