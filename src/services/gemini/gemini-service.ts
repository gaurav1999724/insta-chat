import {
  GoogleGenAI,
  FinishReason,
  Type,
  type Candidate,
  type Schema,
} from "@google/genai";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/validation/env";
import { GeminiApiError } from "@/lib/gemini/errors";
import { buildPrompt } from "@/lib/gemini/prompt-builder";
import { validateAIResponse } from "@/lib/gemini/response-validator";
import { getAIGenerationContext } from "@/lib/conversations/get-ai-context";
import { logOperation } from "@/lib/logging/logger";

// The only module that calls the Gemini SDK (PROJECT_ANALYSIS.md §7) —
// never call @google/genai from a component, route handler, or action
// directly.

function getClient(): GoogleGenAI {
  if (!env.GEMINI_API_KEY) {
    throw new GeminiApiError(
      "Gemini is not configured on this server (missing GEMINI_API_KEY).",
    );
  }
  return new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
}

const RETRYABLE_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1500];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Google's own SDK classifies a 5xx as "ServerError" (vs. a 4xx
// "ClientError") — 5xxs are exactly the transient, worth-a-retry case
// ("This model is currently experiencing high demand... temporary"),
// while a 4xx (bad key, retired model) never gets better on retry.
function isRetryableGeminiError(error: unknown): boolean {
  return error instanceof Error && error.name === "ServerError";
}

// A quota/rate-limit 429 is a "ClientError" per the split above, but unlike
// a genuinely bad request (bad key, malformed prompt) it isn't a bug —
// confirmed in production 2026-09-25 hitting the free tier's
// GenerateRequestsPerDayPerProjectPerModel quota (20/day). Checked by
// message content, not `error.name`: callGemini() always rewraps whatever
// it throws in a GeminiApiError (name "GeminiApiError"), carrying the
// original message through unchanged — this runs on that wrapped error, not
// the raw SDK one. Detected separately from isRetryableGeminiError so
// callGemini() never burns its 3 attempts retrying it, and so
// generateResponse() can start a cooldown instead (see below) rather than
// hitting the same 429 on every reply.
function isQuotaExceededError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("RESOURCE_EXHAUSTED") || error.message.includes('"code":429'))
  );
}

// Circuit breaker: once Gemini reports its quota is exhausted, every further
// call within the same window would just hit the same 429 — so stop calling
// Gemini at all for a while instead of paying for a network round trip (and
// a failure log) on every single reply. Deliberately not an attempt to
// model Google's actual per-minute/per-day reset schedule (the API's own
// suggested `retryDelay` is for its own internal per-minute bucket, not the
// per-day quota this project actually hit); this is just a pragmatic pause
// before trying Gemini again, using the generic SystemSetting table as a
// shared marker (its `value` holds the cooldown's expiry as an ISO string).
const QUOTA_COOLDOWN_KEY = "GEMINI_QUOTA_COOLDOWN_UNTIL";
const QUOTA_COOLDOWN_MS = 30 * 60_000;

async function getActiveQuotaCooldownUntil(): Promise<Date | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: QUOTA_COOLDOWN_KEY } });
  const until = typeof row?.value === "string" ? new Date(row.value) : null;
  return until && !Number.isNaN(until.getTime()) && until.getTime() > Date.now() ? until : null;
}

async function startQuotaCooldown(): Promise<void> {
  const until = new Date(Date.now() + QUOTA_COOLDOWN_MS).toISOString();
  await prisma.systemSetting.upsert({
    where: { key: QUOTA_COOLDOWN_KEY },
    update: { value: until },
    create: { key: QUOTA_COOLDOWN_KEY, value: until },
  });
}

async function callGemini(
  model: string,
  prompt: Parameters<GoogleGenAI["models"]["generateContent"]>[0],
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRYABLE_ATTEMPTS; attempt++) {
    try {
      return await getClient().models.generateContent(prompt);
    } catch (error) {
      lastError = error;
      if (!isRetryableGeminiError(error) || attempt === RETRYABLE_ATTEMPTS - 1) {
        break;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  throw new GeminiApiError(
    lastError instanceof Error ? lastError.message : "Gemini request failed.",
    lastError,
  );
}

async function summarizeTranscript(model: string, transcript: string): Promise<string> {
  const response = await callGemini(model, {
    model,
    contents: [
      "Summarize the key facts, topics, and context from this conversation in 3-5 short sentences, for another assistant to use as background context later.",
      "Output only the summary — no greeting, no preamble, no labels.",
      "",
      transcript,
    ].join("\n"),
  });

  const summary = response.text?.trim();
  if (!summary) {
    throw new GeminiApiError("Gemini returned an empty summary.");
  }

  return summary;
}

// Context-window management (spec §45): when a conversation has more
// messages than fit in the recent-messages window, make sure a summary
// exists covering everything older than that window, generating one if
// none exists yet or the existing one doesn't reach far enough. Returns
// the summary text to use (or the untouched existing one, or null for a
// conversation short enough to need no summary at all).
export async function summarizeConversation(
  conversationId: string,
): Promise<string | null> {
  const context = await getAIGenerationContext(conversationId);

  if (context.totalMessageCount <= context.maxContextMessages) {
    return context.conversationSummary;
  }

  const olderMessages = await prisma.message.findMany({
    where: { conversationId, senderType: { not: "SYSTEM" }, text: { not: null } },
    orderBy: { createdAt: "asc" },
    take: context.totalMessageCount - context.maxContextMessages,
    select: { direction: true, text: true, createdAt: true },
  });

  if (olderMessages.length === 0) {
    return context.conversationSummary;
  }

  const boundary = olderMessages[olderMessages.length - 1].createdAt;
  if (context.latestSummary && context.latestSummary.messageRangeEnd >= boundary) {
    return context.conversationSummary;
  }

  const transcript = olderMessages
    .map(
      (message) =>
        `${message.direction === "INBOUND" ? "Contact" : "Account owner"}: ${message.text}`,
    )
    .join("\n");

  const summary = await summarizeTranscript(context.model, transcript);

  await prisma.conversationSummary.create({
    data: {
      conversationId,
      summary,
      messageRangeStart: olderMessages[0].createdAt,
      messageRangeEnd: boundary,
    },
  });

  return summary;
}

// No native confidence score comes back from the API — this is a
// best-effort signal, not a calibrated probability. `avgLogprobs` (average
// per-token log-probability) exponentiates to an average per-token
// probability; absent that, a non-STOP finish reason (cut off, filtered)
// lowers confidence, and a plain STOP with no logprobs gets a neutral
// default.
function estimateConfidence(candidate: Candidate | undefined): number {
  if (typeof candidate?.avgLogprobs === "number") {
    return Math.min(1, Math.max(0, Math.exp(candidate.avgLogprobs)));
  }
  if (candidate?.finishReason && candidate.finishReason !== FinishReason.STOP) {
    return 0.4;
  }
  return 0.75;
}

export type GenerateResponseResult = {
  text: string;
  confidence: number;
  provider: "GEMINI";
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  durationMs: number;
};

// spec §22: generateAIResponse(). `suggestedFollowUp`/`reason` from the
// spec's output shape aren't produced yet — that would need a second model
// call or structured output, neither implemented this phase.
export async function generateResponse(
  conversationId: string,
): Promise<GenerateResponseResult> {
  const startedAt = Date.now();

  try {
    const cooldownUntil = await getActiveQuotaCooldownUntil();
    if (cooldownUntil) {
      throw new GeminiApiError(
        `Gemini is paused after hitting its quota limit; resuming automatically at ${cooldownUntil.toISOString()}.`,
        { quotaCooldown: true },
      );
    }

    const context = await getAIGenerationContext(conversationId);
    const conversationSummary = await summarizeConversation(conversationId);

    const { systemInstruction, contents } = buildPrompt({
      ...context,
      conversationSummary,
    });

    if (contents.length === 0) {
      throw new GeminiApiError("No conversation history to respond to.");
    }

    const response = await callGemini(context.model, {
      model: context.model,
      contents,
      config: { systemInstruction, temperature: context.temperature },
    });
    const durationMs = Date.now() - startedAt;

    const text = response.text?.trim();
    if (!text) {
      throw new GeminiApiError(
        "Gemini returned an empty response.",
        response.promptFeedback,
      );
    }

    // spec §47: validate before this ever reaches the user.
    const validation = validateAIResponse(text, context.language);
    if (!validation.valid) {
      throw new GeminiApiError(
        `AI response failed validation: ${validation.detail}`,
        validation,
      );
    }

    logOperation({
      conversationId,
      operation: "ai.gemini_generate",
      status: "success",
      durationMs,
      errorCode: `model_${context.model}`,
    });

    return {
      text,
      confidence: estimateConfidence(response.candidates?.[0]),
      provider: "GEMINI",
      model: context.model,
      promptTokens: response.usageMetadata?.promptTokenCount ?? null,
      completionTokens: response.usageMetadata?.candidatesTokenCount ?? null,
      totalTokens: response.usageMetadata?.totalTokenCount ?? null,
      durationMs,
    };
  } catch (error) {
    const inCooldown =
      error instanceof GeminiApiError &&
      typeof error.details === "object" &&
      error.details !== null &&
      (error.details as { quotaCooldown?: boolean }).quotaCooldown === true;
    const quotaExceeded = !inCooldown && isQuotaExceededError(error);

    if (quotaExceeded) {
      await startQuotaCooldown();
    }

    logOperation({
      conversationId,
      operation: "ai.gemini_generate",
      status: "failure",
      durationMs: Date.now() - startedAt,
      errorCode: inCooldown
        ? "GEMINI_QUOTA_COOLDOWN"
        : quotaExceeded
          ? "GEMINI_QUOTA_EXCEEDED"
          : "GEMINI_ERROR",
      detail: error instanceof Error ? error.message : "Unknown Gemini error.",
    });
    throw error;
  }
}

function parseJsonResponse(text: string | undefined, context: string): unknown {
  if (!text) {
    throw new GeminiApiError(`Gemini returned an empty response while ${context}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiApiError(`Gemini returned malformed JSON while ${context}.`, text);
  }
}

// spec §19: extract durable facts from the conversation. Manual/on-demand
// only this phase (a "Refresh memory" button) — nothing calls this
// automatically off an inbound message yet; that kind of automatic
// processing is Phase 9.
const memoryFactSchema = z.object({
  category: z.string().min(1).max(50),
  key: z.string().min(1).max(100),
  value: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
});
const memoryExtractionResultSchema = z.object({
  facts: z.array(memoryFactSchema).max(20),
});

export type ExtractedMemoryFact = z.infer<typeof memoryFactSchema>;

const MEMORY_EXTRACTION_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    facts: {
      type: Type.ARRAY,
      description: "Durable facts worth remembering about the Contact. Empty if none.",
      items: {
        type: Type.OBJECT,
        properties: {
          category: {
            type: Type.STRING,
            description:
              "e.g. preference, interest, important_date, ongoing_topic, relevant_fact",
          },
          key: { type: Type.STRING, description: "short identifier, e.g. favorite_food" },
          value: { type: Type.STRING },
          confidence: { type: Type.NUMBER, description: "0 to 1" },
        },
        required: ["category", "key", "value", "confidence"],
      },
    },
  },
  required: ["facts"],
};

export async function extractMemory(
  conversationId: string,
): Promise<ExtractedMemoryFact[]> {
  const messages = await prisma.message.findMany({
    where: { conversationId, senderType: { not: "SYSTEM" }, text: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { direction: true, text: true },
  });

  if (messages.length === 0) {
    return [];
  }
  messages.reverse();

  const transcript = messages
    .map(
      (message) =>
        `${message.direction === "INBOUND" ? "Contact" : "Account owner"}: ${message.text}`,
    )
    .join("\n");

  const response = await callGemini(env.GEMINI_MODEL, {
    model: env.GEMINI_MODEL,
    contents: [
      "Analyze this conversation and extract useful durable facts about the Contact only — things like their preferred name, interests, important dates they mentioned, ongoing topics, preferences, or other relevant facts (spec-driven categories, keep category names short and lowercase).",
      "Only extract facts explicitly stated or clearly implied by the Contact. Never invent anything.",
      "Do not extract facts about the Account owner, and do not infer sensitive personal characteristics (health, religion, sexual orientation, political views, etc.) even if mentioned.",
      "If there's nothing durable worth remembering, return an empty facts array.",
      "",
      transcript,
    ].join("\n"),
    config: {
      responseMimeType: "application/json",
      responseSchema: MEMORY_EXTRACTION_SCHEMA,
    },
  });

  const json = parseJsonResponse(response.text, "extracting memory");
  const parsed = memoryExtractionResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new GeminiApiError(
      "Gemini's memory extraction output didn't match the expected shape.",
      parsed.error.issues,
    );
  }

  return parsed.data.facts;
}

// spec §21: style is observed only from the Contact's own messages, never
// the account owner's — the point is to match their style, not judge it.
// "Do not infer sensitive personal characteristics" applies here too.
const styleAnalysisSchema = z.object({
  averageMessageLength: z.string().max(50),
  emojiUsage: z.string().max(50),
  languageMix: z.string().max(100),
  punctuationStyle: z.string().max(100),
  formality: z.string().max(50),
  commonExpressions: z.array(z.string().max(100)).max(10),
});

export type CommunicationStyleAnalysis = z.infer<typeof styleAnalysisSchema>;

const STYLE_ANALYSIS_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    averageMessageLength: { type: Type.STRING, description: "short, medium, or long" },
    emojiUsage: { type: Type.STRING, description: "none, low, medium, or high" },
    languageMix: {
      type: Type.STRING,
      description: "e.g. mostly English, mostly Hindi, balanced Hinglish",
    },
    punctuationStyle: {
      type: Type.STRING,
      description: "e.g. minimal, heavy, uses ellipses often",
    },
    formality: { type: Type.STRING, description: "formal or informal" },
    commonExpressions: {
      type: Type.ARRAY,
      description: "Recurring words/phrases this person uses, if any.",
      items: { type: Type.STRING },
    },
  },
  required: [
    "averageMessageLength",
    "emojiUsage",
    "languageMix",
    "punctuationStyle",
    "formality",
    "commonExpressions",
  ],
};

export async function analyzeCommunicationStyle(
  conversationId: string,
): Promise<CommunicationStyleAnalysis> {
  const messages = await prisma.message.findMany({
    where: { conversationId, direction: "INBOUND", text: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { text: true },
  });

  if (messages.length === 0) {
    throw new GeminiApiError("No messages from this contact yet to analyze.");
  }
  messages.reverse();

  const transcript = messages.map((message) => message.text).join("\n");

  const response = await callGemini(env.GEMINI_MODEL, {
    model: env.GEMINI_MODEL,
    contents: [
      "Analyze only the following person's messaging style — average message length, emoji usage, English/Hindi language mix, punctuation style, formal or informal tone, and any recurring expressions.",
      "Use this only to describe conversational style. Do not infer sensitive personal characteristics (health, religion, sexual orientation, political views, age, etc.).",
      "",
      transcript,
    ].join("\n"),
    config: {
      responseMimeType: "application/json",
      responseSchema: STYLE_ANALYSIS_SCHEMA,
    },
  });

  const json = parseJsonResponse(response.text, "analyzing communication style");
  const parsed = styleAnalysisSchema.safeParse(json);
  if (!parsed.success) {
    throw new GeminiApiError(
      "Gemini's style analysis output didn't match the expected shape.",
      parsed.error.issues,
    );
  }

  return parsed.data;
}
