import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/validation/env";
import { SYSTEM_CONFIG_KEYS, type SystemConfigKey } from "@/lib/config/system-config-keys";

export { SYSTEM_CONFIG_KEYS, type SystemConfigKey };

// Runtime-overridable secrets: editable from Settings without a redeploy.
// A `SystemSetting` row (if present and non-empty) wins over the matching
// env var of the same name, so an existing .env-only deployment keeps
// working untouched until someone saves a value through the UI.

export async function getSystemConfig(key: SystemConfigKey): Promise<string | undefined> {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  if (typeof row?.value === "string" && row.value.length > 0) {
    return row.value;
  }
  return env[key];
}

export async function setSystemConfig(key: SystemConfigKey, value: string): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

// Whether each key currently resolves to *something* (DB override or env
// fallback) — used to render the Settings form without ever sending the
// actual secret value back down to the browser.
export async function getSystemConfigStatus(): Promise<Record<SystemConfigKey, boolean>> {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: [...SYSTEM_CONFIG_KEYS] } },
    select: { key: true, value: true },
  });
  const configuredInDb = new Map(
    rows.map((row) => [row.key, typeof row.value === "string" && row.value.length > 0]),
  );

  return Object.fromEntries(
    SYSTEM_CONFIG_KEYS.map((key) => [key, configuredInDb.get(key) ?? Boolean(env[key])]),
  ) as Record<SystemConfigKey, boolean>;
}
