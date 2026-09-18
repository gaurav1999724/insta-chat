import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ConversationStatusFilter } from "@/lib/conversations/get-conversation-list";

const FILTERS: { value: ConversationStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ai", label: "AI Enabled" },
  { value: "human", label: "Human" },
  { value: "unread", label: "Unread" },
  { value: "active", label: "Active" },
];

function buildHref(status: ConversationStatusFilter, search: string | undefined) {
  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  if (search) params.set("q", search);
  const query = params.toString();
  return query ? `/conversations?${query}` : "/conversations";
}

export function ConversationFilters({
  status,
  search,
}: {
  status: ConversationStatusFilter;
  search?: string;
}) {
  return (
    <div className="space-y-2 border-b p-3">
      <form method="get" action="/conversations">
        {status !== "all" && <input type="hidden" name="status" value={status} />}
        <Input name="q" placeholder="Search conversations…" defaultValue={search} />
      </form>
      <div className="flex flex-wrap gap-1">
        {FILTERS.map((filter) => (
          <Button
            key={filter.value}
            asChild
            size="sm"
            variant={filter.value === status ? "default" : "outline"}
            className={cn("h-7 px-2 text-xs")}
          >
            <Link href={buildHref(filter.value, search)}>{filter.label}</Link>
          </Button>
        ))}
      </div>
    </div>
  );
}
