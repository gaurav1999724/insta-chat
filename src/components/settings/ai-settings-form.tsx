"use client";

import { useTransition, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { z } from "zod";
import {
  AIProvider,
  EmojiLevel,
  Language,
  ResponseDelayMode,
  ResponseLength,
} from "@prisma/client";

import { updateAIConfiguration } from "@/app/settings/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NO_DEFAULT_MODE = "none";

const formSchema = z
  .object({
    language: z.nativeEnum(Language),
    responseLength: z.nativeEnum(ResponseLength),
    emojiLevel: z.nativeEnum(EmojiLevel),
    autoSend: z.boolean(),
    responseDelayMode: z.nativeEnum(ResponseDelayMode),
    responseDelayMinMs: z.number().int().min(0).max(60_000),
    responseDelayMaxMs: z.number().int().min(0).max(60_000),
    memoryEnabled: z.boolean(),
    styleMatchingEnabled: z.boolean(),
    maxContextMessages: z.number().int().min(1).max(100),
    aiProvider: z.nativeEnum(AIProvider),
    model: z.string().trim().min(1, "Model is required"),
    temperature: z.number().min(0).max(2),
  })
  .refine((data) => data.responseDelayMaxMs >= data.responseDelayMinMs, {
    message: "Max delay must be greater than or equal to min delay",
    path: ["responseDelayMaxMs"],
  });

type FormValues = z.infer<typeof formSchema>;

export type ChatModeOption = { id: string; name: string; isBuiltIn: boolean };

export function AISettingsForm({
  config,
  chatModes,
}: {
  config: FormValues & { defaultChatModeId: string | null };
  chatModes: ChatModeOption[];
}) {
  const [defaultChatModeId, setDefaultChatModeId] = useState(
    config.defaultChatModeId ?? NO_DEFAULT_MODE,
  );
  const [isPending, startTransition] = useTransition();

  const {
    control,
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: config,
  });

  const responseDelayMode = watch("responseDelayMode");

  const onSubmit = (data: FormValues) => {
    startTransition(async () => {
      const result = await updateAIConfiguration({
        ...data,
        defaultChatModeId:
          defaultChatModeId === NO_DEFAULT_MODE ? null : defaultChatModeId,
      });

      if (result.success) {
        toast.success("AI settings saved");
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Default chat mode</Label>
          <Select value={defaultChatModeId} onValueChange={setDefaultChatModeId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_DEFAULT_MODE}>None</SelectItem>
              {chatModes.map((mode) => (
                <SelectItem key={mode.id} value={mode.id}>
                  {mode.name}
                  {mode.isBuiltIn ? "" : " (custom)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Language</Label>
          <Controller
            control={control}
            name="language"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={Language.HINGLISH}>Hinglish</SelectItem>
                  <SelectItem value={Language.HINDI}>Hindi</SelectItem>
                  <SelectItem value={Language.ENGLISH}>English</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>

        <div className="space-y-1.5">
          <Label>Response length</Label>
          <Controller
            control={control}
            name="responseLength"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ResponseLength.SHORT}>Short</SelectItem>
                  <SelectItem value={ResponseLength.NORMAL}>Normal</SelectItem>
                  <SelectItem value={ResponseLength.DETAILED}>Detailed</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>

        <div className="space-y-1.5">
          <Label>Emoji level</Label>
          <Controller
            control={control}
            name="emojiLevel"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EmojiLevel.NONE}>None</SelectItem>
                  <SelectItem value={EmojiLevel.LOW}>Low</SelectItem>
                  <SelectItem value={EmojiLevel.MEDIUM}>Medium</SelectItem>
                  <SelectItem value={EmojiLevel.HIGH}>High</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>

        <div className="space-y-1.5">
          <Label>Response delay</Label>
          <Controller
            control={control}
            name="responseDelayMode"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ResponseDelayMode.INSTANT}>Instant</SelectItem>
                  <SelectItem value={ResponseDelayMode.NATURAL}>Natural</SelectItem>
                  <SelectItem value={ResponseDelayMode.CUSTOM}>Custom</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>

        <div className="space-y-1.5">
          <Label>Reply AI provider</Label>
          <Controller
            control={control}
            name="aiProvider"
            render={({ field }) => (
              <div className="flex flex-wrap gap-4 pt-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={field.name}
                    value={AIProvider.AUTO}
                    checked={field.value === AIProvider.AUTO}
                    onChange={() => field.onChange(AIProvider.AUTO)}
                  />
                  Gemini first, ChatGPT fallback
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={field.name}
                    value={AIProvider.GEMINI}
                    checked={field.value === AIProvider.GEMINI}
                    onChange={() => field.onChange(AIProvider.GEMINI)}
                  />
                  Gemini only
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={field.name}
                    value={AIProvider.OPENAI}
                    checked={field.value === AIProvider.OPENAI}
                    onChange={() => field.onChange(AIProvider.OPENAI)}
                  />
                  ChatGPT only
                </label>
              </div>
            )}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="model">Gemini model</Label>
          <Input id="model" {...register("model")} />
          {errors.model && (
            <p className="text-xs text-destructive">{errors.model.message}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="responseDelayMinMs">Min delay (ms)</Label>
          <Input
            id="responseDelayMinMs"
            type="number"
            disabled={responseDelayMode === ResponseDelayMode.INSTANT}
            {...register("responseDelayMinMs", { valueAsNumber: true })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="responseDelayMaxMs">Max delay (ms)</Label>
          <Input
            id="responseDelayMaxMs"
            type="number"
            disabled={responseDelayMode === ResponseDelayMode.INSTANT}
            {...register("responseDelayMaxMs", { valueAsNumber: true })}
          />
          {errors.responseDelayMaxMs && (
            <p className="text-xs text-destructive">
              {errors.responseDelayMaxMs.message}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="maxContextMessages">Max context messages</Label>
          <Input
            id="maxContextMessages"
            type="number"
            {...register("maxContextMessages", { valueAsNumber: true })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="temperature">Temperature</Label>
          <Input
            id="temperature"
            type="number"
            step="0.1"
            {...register("temperature", { valueAsNumber: true })}
          />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <Label htmlFor="autoSend">Auto-send AI replies</Label>
            <p className="text-xs text-muted-foreground">
              Off = every AI reply waits for your approval before sending.
            </p>
          </div>
          <Controller
            control={control}
            name="autoSend"
            render={({ field }) => (
              <Switch
                id="autoSend"
                checked={field.value}
                onCheckedChange={field.onChange}
              />
            )}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label htmlFor="memoryEnabled">Conversation memory</Label>
            <p className="text-xs text-muted-foreground">
              Let the AI extract and reuse durable facts from conversations.
            </p>
          </div>
          <Controller
            control={control}
            name="memoryEnabled"
            render={({ field }) => (
              <Switch
                id="memoryEnabled"
                checked={field.value}
                onCheckedChange={field.onChange}
              />
            )}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label htmlFor="styleMatchingEnabled">Style matching</Label>
            <p className="text-xs text-muted-foreground">
              Adapt tone and length to match how the other person writes.
            </p>
          </div>
          <Controller
            control={control}
            name="styleMatchingEnabled"
            render={({ field }) => (
              <Switch
                id="styleMatchingEnabled"
                checked={field.value}
                onCheckedChange={field.onChange}
              />
            )}
          />
        </div>
      </div>

      <Button type="submit" disabled={isPending}>
        {isPending ? "Saving…" : "Save AI settings"}
      </Button>
    </form>
  );
}
