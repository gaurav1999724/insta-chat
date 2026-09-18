import {
  Camera,
  MessagesSquare,
  Bot,
  MessageCircle,
  Sparkles,
  UserCog,
  Gauge,
  AlertTriangle,
} from "lucide-react";

import { AppShell } from "@/components/layout/app-shell";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/require-user";
import { getDashboardStats } from "./get-dashboard-stats";

export default async function DashboardPage() {
  const user = await requireUser();
  const stats = await getDashboardStats(user.id);

  const cards = [
    {
      label: "Connected Instagram account",
      value: stats.connectedAccountUsername
        ? `@${stats.connectedAccountUsername}`
        : "Not connected",
      icon: Camera,
    },
    {
      label: "Active conversations",
      value: stats.activeConversations,
      icon: MessagesSquare,
    },
    { label: "AI enabled conversations", value: stats.aiEnabledConversations, icon: Bot },
    { label: "Messages today", value: stats.messagesToday, icon: MessageCircle },
    { label: "AI generated messages", value: stats.aiGeneratedMessages, icon: Sparkles },
    {
      label: "Human takeover conversations",
      value: stats.humanTakeoverConversations,
      icon: UserCog,
    },
    { label: "Gemini usage", value: `${stats.geminiTokensTotal} tokens`, icon: Gauge },
    { label: "Errors", value: stats.errorCount, icon: AlertTriangle },
  ];

  return (
    <AppShell userLabel={user.email ?? user.name ?? "Account"}>
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Live counts, scoped to your account. Most will read zero until Instagram is
            connected (Phase 4) — full historical breakdowns land in Phase 11.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {cards.map(({ label, value, icon: Icon }) => (
            <Card key={label}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{label}</CardTitle>
                <Icon className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">{value}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
