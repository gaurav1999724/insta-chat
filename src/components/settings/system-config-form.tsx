"use client";

import { useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

import { updateSystemConfig } from "@/app/settings/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { systemConfigFormSchema, type SystemConfigFormValues } from "@/lib/validation/system-config";
import type { SystemConfigKey } from "@/lib/config/system-config";

const FIELDS: { key: SystemConfigKey; label: string; description: string }[] = [
  {
    key: "SOCIALAPI_TOKEN",
    label: "SocialAPI.AI token",
    description: "Authenticates every Instagram API call to social-api.ai.",
  },
  {
    key: "SOCIALAPI_WEBHOOK_SECRET",
    label: "SocialAPI.AI webhook secret",
    description: "Verifies the signature on every incoming Instagram webhook delivery.",
  },
  {
    key: "GEMINI_API_KEY",
    label: "Gemini API key",
    description: "Used for AI reply generation, memory extraction, and style analysis.",
  },
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI API key",
    description: "Used when the ChatGPT provider is selected (or as the AUTO fallback).",
  },
];

const EMPTY_VALUES: SystemConfigFormValues = {
  SOCIALAPI_TOKEN: "",
  SOCIALAPI_WEBHOOK_SECRET: "",
  GEMINI_API_KEY: "",
  OPENAI_API_KEY: "",
};

export function SystemConfigForm({
  status,
}: {
  status: Record<SystemConfigKey, boolean>;
}) {
  const [isPending, startTransition] = useTransition();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<SystemConfigFormValues>({
    resolver: zodResolver(systemConfigFormSchema),
    defaultValues: EMPTY_VALUES,
  });

  const onSubmit = (data: SystemConfigFormValues) => {
    startTransition(async () => {
      const result = await updateSystemConfig(data);
      if (result.success) {
        toast.success("Saved. Takes effect on the next request — no redeploy needed.");
        reset(EMPTY_VALUES);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map(({ key, label, description }) => (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={key}>{label}</Label>
            <Input
              id={key}
              type="password"
              autoComplete="off"
              placeholder={status[key] ? "•••••••••••• (configured — leave blank to keep)" : "Not configured"}
              {...register(key)}
            />
            <p className="text-xs text-muted-foreground">{description}</p>
            {errors[key] && <p className="text-xs text-destructive">{errors[key]?.message}</p>}
          </div>
        ))}
      </div>
      <Button type="submit" disabled={isPending}>
        {isPending ? "Saving…" : "Save credentials"}
      </Button>
    </form>
  );
}
