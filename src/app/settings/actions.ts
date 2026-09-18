"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/require-user";
import { prisma } from "@/lib/db/prisma";
import { encrypt } from "@/lib/security/encryption";
import { aiConfigurationFormSchema } from "@/lib/validation/ai-configuration";
import { chatModeFormSchema, generateChatModeKey } from "@/lib/validation/chat-mode";

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
    select: { id: true },
  });

  if (!account) {
    return { success: false, error: "Instagram account not found" };
  }

  await prisma.$transaction([
    prisma.instagramAccount.update({
      where: { id: account.id },
      data: {
        status: "DISCONNECTED",
        // Wipe the stored token — a disconnect must not leave a usable
        // credential behind, even encrypted at rest.
        accessTokenEncrypted: encrypt(""),
        tokenExpiresAt: null,
      },
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
