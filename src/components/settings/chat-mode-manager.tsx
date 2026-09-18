"use client";

import { useState, useTransition } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { EmojiLevel, Language, ResponseLength } from "@prisma/client";

import { z } from "zod";

import { createChatMode, deleteChatMode } from "@/app/settings/actions";
import { chatModeFormSchema } from "@/lib/validation/chat-mode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type CustomChatMode = {
  id: string;
  name: string;
  description: string | null;
};

// The server schema's `examples` is a string[] (spec §43), but a textarea
// gives one string with newlines — validate everything else against the
// real schema and handle examples as free text here, split on submit.
const formSchema = chatModeFormSchema.omit({ examples: true }).extend({
  examplesText: z.string().optional(),
});
type FormValues = z.infer<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  name: "",
  description: "",
  personalityInstructions: "",
  language: Language.HINGLISH,
  responseLength: ResponseLength.SHORT,
  emojiLevel: EmojiLevel.MEDIUM,
  examplesText: "",
  restrictions: "",
};

export function ChatModeManager({ customModes }: { customModes: CustomChatMode[] }) {
  const [showForm, setShowForm] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: DEFAULT_VALUES,
  });

  const onSubmit = (data: FormValues) => {
    // Textarea gives one example per line; drop blanks and cap at 5 (spec §43).
    const examples = (data.examplesText ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 5);

    startTransition(async () => {
      const result = await createChatMode({
        name: data.name,
        description: data.description,
        personalityInstructions: data.personalityInstructions,
        language: data.language,
        responseLength: data.responseLength,
        emojiLevel: data.emojiLevel,
        restrictions: data.restrictions,
        examples,
      });
      if (result.success) {
        toast.success(`Chat mode "${data.name}" created`);
        reset(DEFAULT_VALUES);
        setShowForm(false);
      } else {
        toast.error(result.error);
      }
    });
  };

  const onDelete = (id: string, name: string) => {
    setDeletingId(id);
    startTransition(async () => {
      const result = await deleteChatMode(id);
      if (result.success) {
        toast.success(`Chat mode "${name}" deleted`);
      } else {
        toast.error(result.error);
      }
      setDeletingId(null);
    });
  };

  return (
    <div className="space-y-4">
      {customModes.length > 0 && (
        <ul className="space-y-2">
          {customModes.map((mode) => (
            <li
              key={mode.id}
              className="flex items-center justify-between gap-4 rounded-md border px-3 py-2"
            >
              <div>
                <p className="text-sm font-medium">{mode.name}</p>
                {mode.description && (
                  <p className="text-xs text-muted-foreground">{mode.description}</p>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={isPending && deletingId === mode.id}
                onClick={() => onDelete(mode.id, mode.name)}
                aria-label={`Delete ${mode.name}`}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {customModes.length === 0 && !showForm && (
        <p className="text-sm text-muted-foreground">
          No custom chat modes yet. Create one to give the AI a distinct personality for
          specific conversations.
        </p>
      )}

      {showForm ? (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 rounded-md border p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cm-name">Name</Label>
              <Input id="cm-name" placeholder="Best Friend" {...register("name")} />
              {errors.name && (
                <p className="text-xs text-destructive">{errors.name.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cm-description">Description (optional)</Label>
              <Input
                id="cm-description"
                placeholder="Casual, teasing, close-friend energy"
                {...register("description")}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cm-instructions">Personality instructions</Label>
            <Textarea
              id="cm-instructions"
              rows={3}
              placeholder="Talk like a close Indian friend. Use casual Hinglish, light jokes and natural teasing. Keep replies short."
              {...register("personalityInstructions")}
            />
            {errors.personalityInstructions && (
              <p className="text-xs text-destructive">
                {errors.personalityInstructions.message}
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
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
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cm-examples">Example replies (optional, one per line, up to 5)</Label>
            <Textarea
              id="cm-examples"
              rows={3}
              placeholder={"Arre haan yaar, sab badhiya!\nKal milte hai, chill maar 😄"}
              {...register("examplesText")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cm-restrictions">Restrictions (optional)</Label>
            <Textarea
              id="cm-restrictions"
              rows={2}
              placeholder="Never discuss pricing. Never promise a refund."
              {...register("restrictions")}
            />
          </div>

          <div className="flex gap-2">
            <Button type="submit" disabled={isPending} size="sm">
              {isPending ? "Creating…" : "Create chat mode"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                reset(DEFAULT_VALUES);
                setShowForm(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setShowForm(true)}>
          New chat mode
        </Button>
      )}
    </div>
  );
}
