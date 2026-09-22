"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  approveDraftReply,
  generateDraftReply,
  regenerateDraftReply,
  rejectDraftReply,
  sendDraftReply,
  sendManualMessageAction,
  setConversationAutoSend,
  updateDraftReplyText,
} from "@/app/conversations/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export type PendingDraft = {
  aiResponseId: string;
  text: string;
  confidence: number;
  provider: "GEMINI" | "OPENAI";
  status: "PENDING_APPROVAL" | "APPROVED";
};

// spec §58's approval workflow (Edit / Regenerate / Send / Reject) plus
// spec §61's composer requirements (manual typing / AI generation /
// regenerate / edit / send / discard — "the user must always be able to
// manually communicate"). A draft moves PENDING_APPROVAL → (Approve) →
// APPROVED → (Send) → SENT; with no draft, the box is just a plain
// composer the user can type into and send directly (spec §37/§61),
// completely independent of `aiEnabled`/`humanTakeover`.
export function MessageComposer({
  conversationId,
  initialDraft,
  initialAutoSend,
}: {
  conversationId: string;
  initialDraft: PendingDraft | null;
  initialAutoSend: boolean;
}) {
  const [draft, setDraft] = useState<PendingDraft | null>(initialDraft);
  const [text, setText] = useState(initialDraft?.text ?? "");
  const [autoSend, setAutoSend] = useState(initialAutoSend);
  const [isPending, startTransition] = useTransition();

  // `useState(initialX)` only applies its initial value once, on mount —
  // it never re-syncs when the parent Server Component re-renders with
  // fresh props (e.g. from `ConversationLiveRefresh`'s polling, or the
  // auto-respond webhook path generating/sending a draft entirely
  // server-side with no client interaction at all). Without this, the box
  // would keep showing a stale draft (or a stale Auto-reply state)
  // indefinitely after the real data changed server-side — confirmed
  // 2026-09-21: an already-auto-sent draft stayed visible as "Approved —
  // ready to send." since nothing ever told this component it was sent.
  // Only resyncs `text` when the draft's *identity* changes (a different
  // `aiResponseId`, or it disappearing/appearing), so it doesn't clobber
  // in-progress edits to the same draft on every poll.
  const syncedDraftId = useRef(initialDraft?.aiResponseId ?? null);

  // Every local mutation of `draft` goes through this instead of calling
  // `setDraft` directly, so the ref always reflects what this component
  // currently believes the draft's identity is — otherwise a later poll
  // bringing back the *same* value this component set locally (e.g. both
  // `null` after this component's own send) would look like "nothing
  // changed" and could mask a real update in between.
  function updateLocalDraft(next: PendingDraft | null) {
    syncedDraftId.current = next?.aiResponseId ?? null;
    setDraft(next);
  }

  useEffect(() => {
    const incomingId = initialDraft?.aiResponseId ?? null;
    if (incomingId === syncedDraftId.current) return;
    syncedDraftId.current = incomingId;
    setDraft(initialDraft);
    setText(initialDraft?.text ?? "");
  }, [initialDraft]);

  useEffect(() => {
    setAutoSend(initialAutoSend);
  }, [initialAutoSend]);

  function handleAutoSendToggle(checked: boolean) {
    setAutoSend(checked);
    startTransition(async () => {
      const result = await setConversationAutoSend(conversationId, checked);
      if (!result.success) {
        setAutoSend(!checked);
        toast.error(result.error);
      } else {
        toast.success(
          checked
            ? "Auto-reply is on — new messages get an AI reply sent automatically."
            : "Auto-reply is off.",
        );
      }
    });
  }

  function handleGenerate() {
    startTransition(async () => {
      const result = await generateDraftReply(conversationId);
      if (result.success) {
        updateLocalDraft({ ...result.draft, status: "PENDING_APPROVAL" });
        setText(result.draft.text);
        toast.success(
          `Draft generated (~${Math.round(result.draft.confidence * 100)}% confidence)`,
        );
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleRegenerate() {
    if (!draft) return;
    startTransition(async () => {
      const result = await regenerateDraftReply(conversationId, draft.aiResponseId);
      if (result.success) {
        updateLocalDraft({ ...result.draft, status: "PENDING_APPROVAL" });
        setText(result.draft.text);
        toast.success("Regenerated");
      } else {
        toast.error(result.error);
      }
    });
  }

  async function saveEditsIfNeeded(currentDraft: PendingDraft): Promise<boolean> {
    if (text === currentDraft.text) return true;
    const result = await updateDraftReplyText(currentDraft.aiResponseId, text);
    if (!result.success) {
      toast.error(result.error);
      return false;
    }
    return true;
  }

  function handleApprove() {
    if (!draft) return;
    const currentDraft = draft;
    startTransition(async () => {
      if (!(await saveEditsIfNeeded(currentDraft))) return;
      const result = await approveDraftReply(currentDraft.aiResponseId);
      if (result.success) {
        updateLocalDraft({ ...currentDraft, text, status: "APPROVED" });
        toast.success("Approved — click Send to deliver it.");
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleReject() {
    if (!draft) return;
    startTransition(async () => {
      const result = await rejectDraftReply(draft.aiResponseId);
      if (result.success) {
        toast.success("Draft rejected");
        updateLocalDraft(null);
        setText("");
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleSendApprovedDraft() {
    if (!draft) return;
    startTransition(async () => {
      const result = await sendDraftReply(draft.aiResponseId);
      if (result.success) {
        toast.success("Sent");
        updateLocalDraft(null);
        setText("");
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleSendManual() {
    const trimmed = text.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const result = await sendManualMessageAction(conversationId, trimmed);
      if (result.success) {
        toast.success("Sent");
        setText("");
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleDiscard() {
    setText("");
  }

  return (
    <div className="space-y-1.5">
      <div
        className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-2.5 py-1"
        title="When on, new messages get an AI reply generated and sent automatically — nothing to approve."
      >
        <Label htmlFor="auto-send-toggle" className="text-xs font-medium">
          Auto-reply
        </Label>
        <Switch
          id="auto-send-toggle"
          checked={autoSend}
          onCheckedChange={handleAutoSendToggle}
          disabled={isPending}
        />
      </div>
      {draft && (
        <p className="text-xs text-muted-foreground">
          {draft.status === "APPROVED"
            ? `Approved, ready to send (${draft.provider === "OPENAI" ? "ChatGPT" : "Gemini"})`
            : `${draft.provider === "OPENAI" ? "ChatGPT" : "Gemini"} draft (~${Math.round(draft.confidence * 100)}% confidence) — edit freely`}
        </p>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Type a message, or click AI Generate to preview a draft reply."
          className="min-h-16 flex-1"
          disabled={draft?.status === "APPROVED"}
        />
        <div className="flex flex-col gap-2">
          {draft ? (
            draft.status === "APPROVED" ? (
              <Button size="sm" onClick={handleSendApprovedDraft} disabled={isPending}>
                Send
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={handleRegenerate}
                disabled={isPending}
              >
                Regenerate
              </Button>
            )
          ) : (
            <>
              <Button size="sm" onClick={handleGenerate} disabled={isPending}>
                {isPending ? "Generating…" : "AI Generate"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleSendManual}
                disabled={isPending || !text.trim()}
              >
                Send
              </Button>
            </>
          )}
        </div>
      </div>
      {draft ? (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={handleReject} disabled={isPending}>
            Reject
          </Button>
          {draft.status === "PENDING_APPROVAL" && (
            <Button size="sm" onClick={handleApprove} disabled={isPending}>
              Approve
            </Button>
          )}
        </div>
      ) : (
        text.trim() && (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleDiscard}
              disabled={isPending}
            >
              Discard
            </Button>
          </div>
        )
      )}
    </div>
  );
}
