"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  analyzeConversation,
  clearConversationMemory,
  deleteConversationMemory,
} from "@/app/conversations/actions";
import { Button } from "@/components/ui/button";

export type MemoryItem = {
  id: string;
  category: string;
  key: string;
  value: string;
  confidence: number;
};

// spec §19 (memory extraction) + §21 (style learning, stored under the
// "communication_style" category) + §75 (view/delete/clear memory).
export function ConversationMemoryPanel({
  conversationId,
  initialMemories,
}: {
  conversationId: string;
  initialMemories: MemoryItem[];
}) {
  const [memories, setMemories] = useState(initialMemories);
  const [isPending, startTransition] = useTransition();

  function handleAnalyze() {
    startTransition(async () => {
      const result = await analyzeConversation(conversationId);
      if (result.success) {
        toast.success(
          `Found ${result.memoryFactCount} fact(s) and ${result.styleFactCount} style note(s) — refresh to see them.`,
        );
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleDelete(memoryId: string) {
    const previous = memories;
    setMemories((current) => current.filter((memory) => memory.id !== memoryId));
    startTransition(async () => {
      const result = await deleteConversationMemory(memoryId);
      if (!result.success) {
        setMemories(previous);
        toast.error(result.error);
      }
    });
  }

  function handleClearAll() {
    const previous = memories;
    setMemories([]);
    startTransition(async () => {
      const result = await clearConversationMemory(conversationId);
      if (!result.success) {
        setMemories(previous);
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground">Memory</p>
        <Button size="sm" variant="outline" onClick={handleAnalyze} disabled={isPending}>
          Analyze conversation
        </Button>
      </div>

      {memories.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No memory yet — click &quot;Analyze conversation&quot; to extract durable facts
          and communication style from the messages so far.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {memories.map((memory) => (
            <li
              key={memory.id}
              className="flex items-start justify-between gap-2 rounded-md border px-2 py-1.5 text-xs"
            >
              <div className="min-w-0">
                <span className="text-muted-foreground">
                  {memory.category}/{memory.key}:
                </span>{" "}
                <span className="break-words">{memory.value}</span>
              </div>
              <button
                type="button"
                onClick={() => handleDelete(memory.id)}
                disabled={isPending}
                className="shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={`Delete ${memory.category}/${memory.key}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {memories.length > 0 && (
        <Button size="sm" variant="outline" onClick={handleClearAll} disabled={isPending}>
          Clear all memory
        </Button>
      )}
    </div>
  );
}
