"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  approveDraftReply,
  generateDraftReply,
  regenerateDraftReply,
  rejectDraftReply,
  sendDraftReply,
  sendManualMessageAction,
  updateDraftReplyText,
} from "@/app/conversations/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export type PendingDraft = {
  aiResponseId: string;
  text: string;
  confidence: number;
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
}: {
  conversationId: string;
  initialDraft: PendingDraft | null;
}) {
  const [draft, setDraft] = useState<PendingDraft | null>(initialDraft);
  const [text, setText] = useState(initialDraft?.text ?? "");
  const [isPending, startTransition] = useTransition();

  function handleGenerate() {
    startTransition(async () => {
      const result = await generateDraftReply(conversationId);
      if (result.success) {
        setDraft({ ...result.draft, status: "PENDING_APPROVAL" });
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
        setDraft({ ...result.draft, status: "PENDING_APPROVAL" });
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
        setDraft({ ...currentDraft, text, status: "APPROVED" });
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
        setDraft(null);
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
        setDraft(null);
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
    <div className="space-y-2">
      {draft && (
        <p className="text-xs font-medium text-muted-foreground">
          {draft.status === "APPROVED"
            ? "Approved — ready to send."
            : `AI suggested reply (~${Math.round(draft.confidence * 100)}% confidence) — edit freely before approving.`}
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
