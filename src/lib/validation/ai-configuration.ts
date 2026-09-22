import {
  AIProvider,
  EmojiLevel,
  Language,
  ResponseDelayMode,
  ResponseLength,
} from "@prisma/client";
import { z } from "zod";

// Empty string means "no default mode" — normalized to null before hitting Prisma.
const nullableChatModeId = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? null : value))
  .nullable();

export const aiConfigurationFormSchema = z
  .object({
    defaultChatModeId: nullableChatModeId,
    language: z.nativeEnum(Language),
    responseLength: z.nativeEnum(ResponseLength),
    emojiLevel: z.nativeEnum(EmojiLevel),
    autoSend: z.boolean(),
    responseDelayMode: z.nativeEnum(ResponseDelayMode),
    responseDelayMinMs: z.coerce.number().int().min(0).max(60_000),
    responseDelayMaxMs: z.coerce.number().int().min(0).max(60_000),
    memoryEnabled: z.boolean(),
    styleMatchingEnabled: z.boolean(),
    maxContextMessages: z.coerce.number().int().min(1).max(100),
    aiProvider: z.nativeEnum(AIProvider),
    model: z.string().trim().min(1, "Model is required"),
    temperature: z.coerce.number().min(0).max(2),
  })
  .refine((data) => data.responseDelayMaxMs >= data.responseDelayMinMs, {
    message: "Max delay must be greater than or equal to min delay",
    path: ["responseDelayMaxMs"],
  });

export type AIConfigurationFormValues = z.infer<typeof aiConfigurationFormSchema>;
