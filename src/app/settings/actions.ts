"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/require-user";
import { prisma } from "@/lib/db/prisma";
import { setSystemConfig, type SystemConfigKey } from "@/lib/config/system-config";
import { aiConfigurationFormSchema } from "@/lib/validation/ai-configuration";
import { chatModeFormSchema, generateChatModeKey } from "@/lib/validation/chat-mode";
import { systemConfigFormSchema } from "@/lib/validation/system-config";
import {
  disconnectSocialAccount,
  listConnectedAccounts,
} from "@/services/instagram/instagram-service";

export type ActionResult = { success: true } | { success: false; error: string };
export type CreateChatModeResult =
  | { success: true; chatModeId: string }
  | { success: false; error: string };

export async function updateAIConfiguration(values: unknown): Promise<ActionResult> {
  const user = await requireUser();

  const parsed = aiConfigurationFormSchema.safeParse(values);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  if (parsed.data.defaultChatModeId) {
    // Authorization (spec §74): only default to a built-in mode (userId
    // null) or one of this user's own custom modes — never another user's.
    const mode = await prisma.chatMode.findFirst({
      where: {
        id: parsed.data.defaultChatModeId,
        OR: [{ userId: null }, { userId: user.id }],
      },
      select: { id: true },
    });

    if (!mode) {
      return { success: false, error: "Selected chat mode was not found" };
    }
  }

  await prisma.aIConfiguration.upsert({
    where: { userId: user.id },
    update: parsed.data,
    create: { userId: user.id, ...parsed.data },
  });

  revalidatePath("/settings");
  return { success: true };
}

// These are app-wide, not per-user (SocialAPI.AI's token/webhook secret and
// the Gemini/OpenAI API keys are already shared across every user of this
// deployment via env vars today — saving one here changes it for everyone,
// same blast radius as editing .env and redeploying, just without the
// redeploy). Blank fields are left untouched; only a non-empty value
// overwrites its `SystemSetting` row.
export async function updateSystemConfig(values: unknown): Promise<ActionResult> {
  const user = await requireUser();

  const parsed = systemConfigFormSchema.safeParse(values);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const changedKeys = Object.entries(parsed.data).filter(
    (entry): entry is [SystemConfigKey, string] => entry[1].length > 0,
  );
  if (changedKeys.length === 0) {
    return { success: true };
  }

  await Promise.all(changedKeys.map(([key, value]) => setSystemConfig(key, value)));

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "SETTINGS_CHANGED",
      entityType: "SystemSetting",
      metadata: { keys: changedKeys.map(([key]) => key) },
    },
  });

  revalidatePath("/settings");
  return { success: true };
}

export async function createChatMode(values: unknown): Promise<CreateChatModeResult> {
  const user = await requireUser();

  const parsed = chatModeFormSchema.safeParse(values);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { name, description, personalityInstructions, language, responseLength, emojiLevel, examples, restrictions } =
    parsed.data;

  const chatMode = await prisma.chatMode.create({
    data: {
      userId: user.id,
      key: generateChatModeKey(name),
      name,
      description: description || null,
      personalityInstructions,
      language,
      responseLength,
      emojiLevel,
      examples: examples.length > 0 ? examples : undefined,
      restrictions: restrictions || null,
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "CHAT_MODE_CREATED",
      entityType: "ChatMode",
      entityId: chatMode.id,
    },
  });

  revalidatePath("/settings");
  return { success: true, chatModeId: chatMode.id };
}

export async function deleteChatMode(chatModeId: string): Promise<ActionResult> {
  const user = await requireUser();

  // Authorization (spec §74): only the owner can delete their own custom
  // mode — built-in modes (userId null) can never be deleted this way.
  const mode = await prisma.chatMode.findFirst({
    where: { id: chatModeId, userId: user.id },
    select: { id: true },
  });

  if (!mode) {
    return { success: false, error: "Chat mode not found" };
  }

  await prisma.$transaction([
    prisma.chatMode.delete({ where: { id: mode.id } }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "CHAT_MODE_DELETED",
        entityType: "ChatMode",
        entityId: mode.id,
      },
    }),
  ]);

  revalidatePath("/settings");
  return { success: true };
}

export async function disconnectInstagramAccount(
  accountId: string,
): Promise<ActionResult> {
  const user = await requireUser();

  // Authorization (spec §74): only the owning user can disconnect it.
  const account = await prisma.instagramAccount.findFirst({
    where: { id: accountId, userId: user.id },
    select: { id: true, instagramUserId: true },
  });

  if (!account) {
    return { success: false, error: "Instagram account not found" };
  }

  // Real remote disconnect (`DELETE /accounts/{id}`) — this actually frees
  // up the connection slot on SocialAPI.AI's side, not just a local status
  // flip. A 404 (already gone there) is treated as success by
  // `disconnectSocialAccount()` itself; only a genuine API failure stops
  // the local disconnect below, so a transient SocialAPI outage doesn't
  // leave the user stuck with an account they can't get rid of locally.
  try {
    await disconnectSocialAccount(account.instagramUserId);
  } catch {
    return {
      success: false,
      error: "Failed to disconnect the Instagram account. Check the deployment logs.",
    };
  }

  await prisma.$transaction([
    prisma.instagramAccount.update({
      where: { id: account.id },
      data: { status: "DISCONNECTED" },
    }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "ACCOUNT_DISCONNECTED",
        entityType: "InstagramAccount",
        entityId: account.id,
      },
    }),
  ]);

  revalidatePath("/settings");
  revalidatePath("/dashboard");
  return { success: true };
}

// SocialAPI.AI plans typically allow only a small number of connected
// accounts. Rather than making the user disconnect-then-reconnect through
// the OAuth flow just to attach an account that's *already* connected on
// the platform to this InstaMate user, this links it directly — no new
// OAuth round-trip needed since SocialAPI.AI already holds a valid
// connection for it.
export async function adoptConnectedAccount(platformAccountId: string): Promise<ActionResult> {
  const user = await requireUser();

  let liveAccounts;
  try {
    liveAccounts = await listConnectedAccounts();
  } catch {
    return {
      success: false,
      error: "Failed to verify the connected account. Check the deployment logs.",
    };
  }

  const match = liveAccounts.find((a) => a.id === platformAccountId);
  if (!match) {
    return { success: false, error: "That account is no longer connected on SocialAPI.AI." };
  }

  // Authorization (spec §74): never silently hand an account another
  // InstaMate user already claimed over to this one.
  const existing = await prisma.instagramAccount.findUnique({
    where: { instagramUserId: match.id },
    select: { userId: true },
  });
  if (existing && existing.userId !== user.id) {
    return {
      success: false,
      error: "That Instagram account is already connected to a different InstaMate account.",
    };
  }

  const shared = {
    userId: user.id,
    username: match.username,
    displayName: match.name,
    status: "ACTIVE" as const,
  };
  const account = await prisma.instagramAccount.upsert({
    where: { instagramUserId: match.id },
    update: shared,
    create: { instagramUserId: match.id, ...shared },
  });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "ACCOUNT_CONNECTED",
      entityType: "InstagramAccount",
      entityId: account.id,
    },
  });

  revalidatePath("/settings");
  revalidatePath("/dashboard");
  return { success: true };
}
