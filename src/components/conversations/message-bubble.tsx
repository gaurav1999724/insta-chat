import { cn } from "@/lib/utils";

export type MessageBubbleData = {
  id: string;
  senderType: string;
  direction: string;
  messageType: string;
  text: string | null;
  externalTimestamp: Date | null;
  createdAt: Date;
  delivery: { status: string } | null;
};

function formatTime(date: Date) {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function MessageBubble({ message }: { message: MessageBubbleData }) {
  if (message.senderType === "SYSTEM") {
    return (
      <div className="py-1 text-center text-xs text-muted-foreground">
        {message.text ?? `[${message.messageType.toLowerCase()}]`}
      </div>
    );
  }

  const isOutbound = message.direction === "OUTBOUND";
  const timestamp = message.externalTimestamp ?? message.createdAt;

  return (
    <div
      data-message-bubble
      className={cn("flex", isOutbound ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-3 py-2 text-sm",
          isOutbound ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        <p className="whitespace-pre-wrap break-words">
          {message.text ?? `[${message.messageType.toLowerCase()}]`}
        </p>
        <div
          className={cn(
            "mt-1 flex items-center gap-1 text-[10px] opacity-70",
            isOutbound ? "justify-end" : "justify-start",
          )}
        >
          {message.senderType === "AI" && <span>AI</span>}
          <span>{formatTime(timestamp)}</span>
          {message.delivery && <span>· {message.delivery.status.toLowerCase()}</span>}
        </div>
      </div>
    </div>
  );
}
