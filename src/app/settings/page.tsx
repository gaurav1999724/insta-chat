import {
  MessagesSquare,
  Brain,
  Bell,
  ShieldCheck,
  Gauge,
  AlertTriangle,
  Camera,
} from "lucide-react";

import { AppShell } from "@/components/layout/app-shell";
import { AISettingsForm } from "@/components/settings/ai-settings-form";
import { ChatModeManager } from "@/components/settings/chat-mode-manager";
import { RecentErrorsPanel } from "@/components/settings/recent-errors";
import { UsageSummaryPanel } from "@/components/settings/usage-summary";
import { disconnectInstagramAccount } from "./actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { requireUser } from "@/lib/auth/require-user";
import { getOrCreateAIConfiguration } from "@/lib/ai/get-ai-configuration";
import { getRecentErrors } from "@/lib/analytics/get-recent-errors";
import { getUsageSummary } from "@/lib/analytics/get-usage-summary";
import { prisma } from "@/lib/db/prisma";

const OTHER_SETTINGS_SECTIONS = [
  {
    label: "Memory",
    description: "View, edit, or delete stored conversation memory.",
    icon: Brain,
    phase: "Phase 8",
  },
  {
    label: "Notifications",
    description: "In-app notification preferences.",
    icon: Bell,
    phase: "Phase 10",
  },
  {
    label: "Security",
    description: "Token status, encryption, audit log.",
    icon: ShieldCheck,
    phase: "Phase 12",
  },
];

const CONNECT_BANNER: Record<
  string,
  { tone: "success" | "error" | "info"; message: string }
> = {
  connected: { tone: "success", message: "Instagram account connected." },
  denied: { tone: "info", message: "Instagram connection was cancelled." },
  error: {
    tone: "error",
    message: "Something went wrong connecting Instagram. Please try again.",
  },
  not_configured: {
    tone: "error",
    message:
      "Instagram connection isn't configured on this server yet (missing META_APP_ID/META_APP_SECRET).",
  },
  already_connected: {
    tone: "error",
    message:
      "That Instagram account is already connected to a different InstaMate account.",
  },
  rate_limited: {
    tone: "error",
    message: "Too many connection attempts. Please wait a bit and try again.",
  },
};

const BANNER_TONE_CLASSES: Record<"success" | "error" | "info", string> = {
  success: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400",
  error: "border-destructive/30 bg-destructive/10 text-destructive",
  info: "border-border bg-muted text-muted-foreground",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ instagram?: string }>;
}) {
  const user = await requireUser();
  const { instagram: instagramStatus } = await searchParams;

  const [config, chatModes, customChatModes, instagramAccount, usageSummary, recentErrors] =
    await Promise.all([
      getOrCreateAIConfiguration(user.id),
      prisma.chatMode.findMany({
        where: { OR: [{ userId: null }, { userId: user.id }] },
        orderBy: [{ isBuiltIn: "desc" }, { name: "asc" }],
        select: { id: true, name: true, isBuiltIn: true },
      }),
      prisma.chatMode.findMany({
        where: { userId: user.id },
        orderBy: { name: "asc" },
        select: { id: true, name: true, description: true },
      }),
      prisma.instagramAccount.findFirst({
        where: { userId: user.id },
        orderBy: { updatedAt: "desc" },
        select: { id: true, username: true, status: true, tokenExpiresAt: true },
      }),
      getUsageSummary(user.id),
      getRecentErrors(user.id),
    ]);

  const banner = instagramStatus ? CONNECT_BANNER[instagramStatus] : undefined;
  const isConnected = instagramAccount?.status === "ACTIVE";

  return (
    <AppShell userLabel={user.email ?? user.name ?? "Account"}>
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Each section becomes functional as its phase lands.
          </p>
        </div>

        {banner && (
          <div
            className={`rounded-md border px-4 py-3 text-sm ${BANNER_TONE_CLASSES[banner.tone]}`}
          >
            {banner.message}
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Camera className="size-4" />
              Instagram
            </CardTitle>
            <CardDescription>
              Connect the Instagram professional account InstaMate manages conversations
              for.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isConnected ? (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">
                    Connected as @{instagramAccount.username}
                  </p>
                  {instagramAccount.tokenExpiresAt && (
                    <p className="text-xs text-muted-foreground">
                      Access token valid until{" "}
                      {instagramAccount.tokenExpiresAt.toLocaleDateString()}
                    </p>
                  )}
                </div>
                <form
                  action={async () => {
                    "use server";
                    await disconnectInstagramAccount(instagramAccount.id);
                  }}
                >
                  <Button type="submit" variant="outline" size="sm">
                    Disconnect
                  </Button>
                </form>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-muted-foreground">
                  {instagramAccount?.status === "DISCONNECTED"
                    ? `Previously connected as @${instagramAccount.username}. Reconnect to resume.`
                    : "Not connected."}
                </p>
                <Button asChild size="sm">
                  <a href="/api/instagram/connect">Connect Instagram</a>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">AI</CardTitle>
            <CardDescription>
              Global defaults. Individual conversations can override these (Phase 8).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AISettingsForm
              config={{
                defaultChatModeId: config.defaultChatModeId,
                language: config.language,
                responseLength: config.responseLength,
                emojiLevel: config.emojiLevel,
                autoSend: config.autoSend,
                responseDelayMode: config.responseDelayMode,
                responseDelayMinMs: config.responseDelayMinMs,
                responseDelayMaxMs: config.responseDelayMaxMs,
                memoryEnabled: config.memoryEnabled,
                styleMatchingEnabled: config.styleMatchingEnabled,
                maxContextMessages: config.maxContextMessages,
                model: config.model,
                temperature: config.temperature,
              }}
              chatModes={chatModes}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessagesSquare className="size-4" />
              Chat Modes
            </CardTitle>
            <CardDescription>
              Custom personalities the AI can use, in addition to the built-in modes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChatModeManager customModes={customChatModes} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gauge className="size-4" />
              Usage
            </CardTitle>
            <CardDescription>
              Gemini token usage and estimated cost, scoped to your account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <UsageSummaryPanel summary={usageSummary} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4" />
              Recent errors
            </CardTitle>
            <CardDescription>
              The last 25 errors recorded against your account, most recent first.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RecentErrorsPanel errors={recentErrors} />
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {OTHER_SETTINGS_SECTIONS.map(({ label, description, icon: Icon, phase }) => (
            <Card key={label} className="opacity-90">
              <CardHeader className="flex flex-row items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Icon className="size-4" />
                  <CardTitle className="text-base">{label}</CardTitle>
                </div>
                <span className="text-xs text-muted-foreground">{phase}</span>
              </CardHeader>
              <CardDescription className="px-6 pb-4">{description}</CardDescription>
            </Card>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
