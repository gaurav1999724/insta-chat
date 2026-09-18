import type { UsageSummary, UsageWindowStats } from "@/lib/analytics/get-usage-summary";

const WINDOWS: { key: keyof UsageSummary; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "last7Days", label: "7 days" },
  { key: "last30Days", label: "30 days" },
  { key: "allTime", label: "Total" },
];

function formatCost(cost: number | null): string {
  if (cost === null) return "—";
  return `$${cost.toFixed(cost < 1 ? 4 : 2)}`;
}

function WindowStatsCard({ label, stats }: { label: string; stats: UsageWindowStats }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold">{formatCost(stats.estimatedCostUsd)}</p>
      <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
        <div className="flex justify-between">
          <dt>Tokens</dt>
          <dd>{stats.totalTokens.toLocaleString()}</dd>
        </div>
        <div className="flex justify-between">
          <dt>AI replies</dt>
          <dd>{stats.aiResponseCount.toLocaleString()}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Sent / received</dt>
          <dd>
            {stats.messagesSent.toLocaleString()} /{" "}
            {stats.messagesReceived.toLocaleString()}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>Errors</dt>
          <dd>{stats.errorCount.toLocaleString()}</dd>
        </div>
      </dl>
    </div>
  );
}

export function UsageSummaryPanel({ summary }: { summary: UsageSummary }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {WINDOWS.map(({ key, label }) => (
        <WindowStatsCard key={key} label={label} stats={summary[key]} />
      ))}
    </div>
  );
}
