import { EmojiLevel, Language, ResponseLength } from "@prisma/client";
import { z } from "zod";

// spec §43 CUSTOM MODE: Name, Description, Personality instructions,
// Language, Response length, Emoji style, Examples, Restrictions.
export const chatModeFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(50),
  description: z.string().trim().max(200).optional(),
  personalityInstructions: z
    .string()
    .trim()
    .min(1, "Personality instructions are required")
    .max(2000),
  language: z.nativeEnum(Language),
  responseLength: z.nativeEnum(ResponseLength),
  emojiLevel: z.nativeEnum(EmojiLevel),
  // A handful of example replies in this mode's voice — spec §77: "clearly
  // label generated examples as AI-generated" applies to examples *Gemini*
  // suggests elsewhere, not these (user-authored, used as few-shot
  // guidance in the prompt — see buildChatModeExamplesPrompt()).
  examples: z.array(z.string().trim().min(1).max(300)).max(5),
  restrictions: z.string().trim().max(500).optional(),
});

export type ChatModeFormValues = z.infer<typeof chatModeFormSchema>;

// Custom modes need a `key` unique per user (`@@unique([userId, key])`)
// but it's never shown to the user — `name` is the human-facing label —
// so a slug-plus-random-suffix is generated server-side rather than asked
// for, avoiding a duplicate-key retry loop entirely.
export function generateChatModeKey(name: string): string {
  const slug = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${slug || "CUSTOM"}_${suffix}`;
}
