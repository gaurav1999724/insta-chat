// Development seed data (spec §69). Never seeds real Instagram data — every
// external id, username and token below is an obvious placeholder.
import {
  PrismaClient,
  EmojiLevel,
  Language,
  ResponseLength,
  SenderType,
  MessageDirection,
} from "@prisma/client";

const prisma = new PrismaClient();

const BUILT_IN_CHAT_MODES = [
  {
    key: "CASUAL",
    name: "Casual",
    description: "Relaxed, everyday conversational tone.",
    personalityInstructions:
      "Talk like a normal person chatting casually. Keep replies short, natural Hinglish, no formality.",
    emojiLevel: EmojiLevel.LOW,
  },
  {
    key: "FRIENDLY",
    name: "Friendly",
    description: "Warm and approachable, like a good friend.",
    personalityInstructions:
      "Talk like a warm, friendly Indian friend. Be encouraging and easygoing, natural Hinglish, light humor when it fits.",
    emojiLevel: EmojiLevel.MEDIUM,
  },
  {
    key: "ROMANTIC",
    name: "Romantic",
    description: "Affectionate, warm, emotionally caring.",
    personalityInstructions:
      "Be affectionate, playful, caring and emotionally warm, like a loving partner. Never invent real-world actions, meetings, locations or events that were not explicitly provided by the user.",
    emojiLevel: EmojiLevel.MEDIUM,
  },
  {
    key: "FLIRTY",
    name: "Flirty",
    description: "Playful teasing and light flirting.",
    personalityInstructions:
      "Be playful and lightly flirty: teasing, compliments, natural Hinglish banter. Respect boundaries, never become explicit automatically, and always follow the conversation's actual context.",
    emojiLevel: EmojiLevel.MEDIUM,
  },
  {
    key: "STUDY",
    name: "Study",
    description: "Clear, helpful, educational explanations.",
    personalityInstructions:
      "Prioritize clarity and helpfulness. Explain concepts simply and concisely in natural Hinglish, like a patient study partner.",
    responseLength: ResponseLength.NORMAL,
    emojiLevel: EmojiLevel.NONE,
  },
  {
    key: "BUSINESS",
    name: "Business",
    description: "Professional, concise, structured.",
    personalityInstructions:
      "Be professional, concise, polite and clear. No romantic or casual slang. Use structure when it helps.",
    language: Language.ENGLISH,
    responseLength: ResponseLength.NORMAL,
    emojiLevel: EmojiLevel.NONE,
  },
  {
    key: "PROFESSIONAL",
    name: "Professional",
    description: "Formal and precise, for professional contacts.",
    personalityInstructions:
      "Maintain a formal, precise, respectful tone suited for professional contacts. Avoid slang and emojis.",
    language: Language.ENGLISH,
    responseLength: ResponseLength.NORMAL,
    emojiLevel: EmojiLevel.NONE,
  },
  {
    key: "FUNNY",
    name: "Funny",
    description: "Playful humor and jokes.",
    personalityInstructions:
      "Be witty and playful, with natural jokes and light banter in Hinglish. Keep it fun without forcing humor into every line.",
    emojiLevel: EmojiLevel.HIGH,
  },
  {
    key: "SUPPORTIVE",
    name: "Supportive",
    description: "Empathetic and encouraging.",
    personalityInstructions:
      "Be empathetic, encouraging and supportive. Listen first, validate feelings, and offer gentle encouragement in natural Hinglish.",
    emojiLevel: EmojiLevel.LOW,
  },
  {
    key: "CUSTOM",
    name: "Custom",
    description: "Starting point for a user-defined custom mode.",
    personalityInstructions:
      "Follow the user's custom instructions for this conversation exactly, while staying within the natural Hinglish conversational style.",
    emojiLevel: EmojiLevel.MEDIUM,
  },
] as const;

async function seedBuiltInChatModes() {
  const modes = new Map<string, string>();

  for (const mode of BUILT_IN_CHAT_MODES) {
    const existing = await prisma.chatMode.findFirst({
      where: { userId: null, key: mode.key },
    });

    const record = existing
      ? await prisma.chatMode.update({
          where: { id: existing.id },
          data: { ...mode, isBuiltIn: true },
        })
      : await prisma.chatMode.create({
          data: { ...mode, isBuiltIn: true },
        });

    modes.set(mode.key, record.id);
  }

  console.log(`Seeded ${modes.size} built-in chat modes.`);
  return modes;
}

async function seedSampleConversation(casualModeId: string | undefined) {
  const user = await prisma.user.upsert({
    where: { email: "demo@instamate.local" },
    update: {},
    create: {
      email: "demo@instamate.local",
      name: "Demo User",
    },
  });

  await prisma.aIConfiguration.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id },
  });

  const instagramAccount = await prisma.instagramAccount.upsert({
    where: { instagramUserId: "seed-ig-account-demo" },
    update: {},
    create: {
      userId: user.id,
      instagramUserId: "seed-ig-account-demo",
      username: "demo.instamate",
      displayName: "Demo InstaMate Account",
      // Not a real credential — placeholder only, seed data never contains
      // real Instagram tokens.
      accessTokenEncrypted: "seed-placeholder-not-a-real-token",
      status: "ACTIVE",
    },
  });

  const participant = await prisma.instagramParticipant.upsert({
    where: {
      instagramAccountId_externalUserId: {
        instagramAccountId: instagramAccount.id,
        externalUserId: "seed-contact-1",
      },
    },
    update: {},
    create: {
      instagramAccountId: instagramAccount.id,
      externalUserId: "seed-contact-1",
      username: "sample.contact",
      displayName: "Sample Contact",
    },
  });

  const conversation = await prisma.conversation.upsert({
    where: {
      instagramAccountId_externalConversationId: {
        instagramAccountId: instagramAccount.id,
        externalConversationId: "seed-conversation-1",
      },
    },
    update: {},
    create: {
      instagramAccountId: instagramAccount.id,
      externalConversationId: "seed-conversation-1",
      participantId: participant.id,
      chatModeId: casualModeId,
      aiEnabled: true,
      lastMessageAt: new Date(),
    },
  });

  await prisma.conversationSettings.upsert({
    where: { conversationId: conversation.id },
    update: {},
    create: { conversationId: conversation.id },
  });

  const sampleMessages: Array<{
    externalMessageId: string;
    senderType: SenderType;
    direction: MessageDirection;
    text: string;
  }> = [
    {
      externalMessageId: "seed-msg-1",
      senderType: SenderType.CONTACT,
      direction: MessageDirection.INBOUND,
      text: "hey! kaisa hai?",
    },
    {
      externalMessageId: "seed-msg-2",
      senderType: SenderType.AI,
      direction: MessageDirection.OUTBOUND,
      text: "sab badhiya! tu bata, kya chal raha hai?",
    },
    {
      externalMessageId: "seed-msg-3",
      senderType: SenderType.CONTACT,
      direction: MessageDirection.INBOUND,
      text: "bas kaam hi kaam 😅",
    },
  ];

  for (const [index, message] of sampleMessages.entries()) {
    await prisma.message.upsert({
      where: { externalMessageId: message.externalMessageId },
      update: {},
      create: {
        conversationId: conversation.id,
        externalMessageId: message.externalMessageId,
        senderType: message.senderType,
        direction: message.direction,
        text: message.text,
        externalTimestamp: new Date(
          Date.now() - (sampleMessages.length - index) * 60_000,
        ),
      },
    });
  }

  console.log(`Seeded 1 sample conversation with ${sampleMessages.length} messages.`);
}

async function main() {
  const modes = await seedBuiltInChatModes();
  await seedSampleConversation(modes.get("CASUAL"));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
