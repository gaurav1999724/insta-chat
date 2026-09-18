import { Badge } from "@/components/ui/badge";
import type { RecentError } from "@/lib/analytics/get-recent-errors";

const CATEGORY_LABELS: Record<string, string> = {
  GEMINI_ERROR: "Gemini",
  INSTAGRAM_API_ERROR: "Instagram",
  WEBHOOK_ERROR: "Webhook",
};

export function RecentErrorsPanel({ errors }: { errors: RecentError[] }) {
  if (errors.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No errors recorded. Good sign.</p>
    );
  }

  return (
    <ul className="space-y-2">
      {errors.map((error) => (
        <li
          key={error.id}
          className="flex items-start justify-between gap-3 rounded-md border p-3"
        >
          <div className="min-w-0">
            <p className="truncate text-sm">{error.message}</p>
            <p className="text-xs text-muted-foreground">
              {error.createdAt.toLocaleString()}
            </p>
          </div>
          <Badge variant="secondary" className="shrink-0">
            {CATEGORY_LABELS[error.category] ?? error.category}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
