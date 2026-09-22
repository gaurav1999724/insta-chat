import { z } from "zod";

import { SYSTEM_CONFIG_KEYS } from "@/lib/config/system-config";

// Every field is optional and an empty string means "leave unchanged" —
// the form never round-trips actual secret values into the browser, so
// there's nothing to validate as "already correct" versus blank.
export const systemConfigFormSchema = z.object(
  Object.fromEntries(SYSTEM_CONFIG_KEYS.map((key) => [key, z.string().trim()])) as Record<
    (typeof SYSTEM_CONFIG_KEYS)[number],
    z.ZodString
  >,
);

export type SystemConfigFormValues = z.infer<typeof systemConfigFormSchema>;
