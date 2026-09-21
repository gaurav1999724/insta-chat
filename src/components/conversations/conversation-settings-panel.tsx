"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { EmojiLevel, Language, ResponseLength } from "@prisma/client";

import {
  setConversationAIEnabled,
  setConversationChatMode,
  setConversationHumanTakeover,
  updateContactProfile,
  updateConversationAISettings,
} from "@/app/conversations/actions";
import {
  ConversationMemoryPanel,
  type MemoryItem,
} from "@/components/conversations/conversation-memory-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

const NO_MODE = "none";
const INHERIT = "inherit";

export type ChatModeOption = { id: string; name: string; isBuiltIn: boolean };

export type ConversationAISettings = {
  language: Language | null;
  responseLength: ResponseLength | null;
  emojiLevel: EmojiLevel | null;
  memoryEnabled: boolean | null;
  autoSend: boolean | null;
  customInstructions: string;
};

function toTriState(value: boolean | null): string {
  if (value === null) return INHERIT;
  return value ? "true" : "false";
}

function fromTriState(value: string): boolean | null {
  if (value === INHERIT) return null;
  return value === "true";
}

export function ConversationSettingsPanel({
  conversationId,
  initialAiEnabled,
  initialHumanTakeover,
  initialChatModeId,
  chatModes,
  contact,
  initialProfile,
  initialAISettings,
  memories,
}: {
  conversationId: string;
  initialAiEnabled: boolean;
  initialHumanTakeover: boolean;
  initialChatModeId: string | null;
  chatModes: ChatModeOption[];
  contact: { username: string | null; displayName: string | null };
  initialProfile: { preferredName: string; relationshipLabel: string; notes: string };
  initialAISettings: ConversationAISettings;
  memories: MemoryItem[];
}) {
  const [aiEnabled, setAiEnabled] = useState(initialAiEnabled);
  const [humanTakeover, setHumanTakeover] = useState(initialHumanTakeover);
  const [chatModeId, setChatModeId] = useState(initialChatModeId ?? NO_MODE);
  const [profile, setProfile] = useState(initialProfile);
  const [aiSettings, setAiSettings] = useState(initialAISettings);
  const [isPending, startTransition] = useTransition();

  function handleAiToggle(checked: boolean) {
    setAiEnabled(checked);
    startTransition(async () => {
      const result = await setConversationAIEnabled(conversationId, checked);
      if (!result.success) {
        setAiEnabled(!checked);
        toast.error(result.error);
      }
    });
  }

  function handleHumanToggle(checked: boolean) {
    setHumanTakeover(checked);
    startTransition(async () => {
      const result = await setConversationHumanTakeover(conversationId, checked);
      if (!result.success) {
        setHumanTakeover(!checked);
        toast.error(result.error);
      }
    });
  }

  function handleModeChange(value: string) {
    const previous = chatModeId;
    setChatModeId(value);
    startTransition(async () => {
      const result = await setConversationChatMode(
        conversationId,
        value === NO_MODE ? null : value,
      );
      if (!result.success) {
        setChatModeId(previous);
        toast.error(result.error);
      }
    });
  }

  function handleProfileSave() {
    startTransition(async () => {
      const result = await updateContactProfile(conversationId, profile);
      if (result.success) {
        toast.success("Saved");
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleAISettingsSave() {
    startTransition(async () => {
      const result = await updateConversationAISettings(conversationId, aiSettings);
      if (result.success) {
        toast.success("Saved");
      } else {
        toast.error(result.error);
      }
    });
  }

  const displayName = contact.displayName ?? contact.username ?? "Unknown contact";

  return (
    <div className="space-y-6 p-4">
      <div>
        <p className="text-sm font-medium">{displayName}</p>
        {contact.username && (
          <p className="text-xs text-muted-foreground">@{contact.username}</p>
        )}
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="ai-enabled">AI enabled</Label>
          <Switch
            id="ai-enabled"
            checked={aiEnabled}
            onCheckedChange={handleAiToggle}
            disabled={isPending}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="human-takeover">Human takeover</Label>
          <Switch
            id="human-takeover"
            checked={humanTakeover}
            onCheckedChange={handleHumanToggle}
            disabled={isPending}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Chat mode</Label>
          <Select value={chatModeId} onValueChange={handleModeChange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_MODE}>Use default</SelectItem>
              {chatModes.map((mode) => (
                <SelectItem key={mode.id} value={mode.id}>
                  {mode.name}
                  {mode.isBuiltIn ? "" : " (custom)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-3 border-t pt-4">
        <p className="text-xs font-semibold text-muted-foreground">
          AI behavior overrides
        </p>
        <p className="text-xs text-muted-foreground">
          &quot;Inherit&quot; follows your global AI settings.
        </p>

        <div className="space-y-1.5">
          <Label>Language</Label>
          <Select
            value={aiSettings.language ?? INHERIT}
            onValueChange={(value) =>
              setAiSettings((current) => ({
                ...current,
                language: value === INHERIT ? null : (value as Language),
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>Inherit</SelectItem>
              <SelectItem value={Language.HINGLISH}>Hinglish</SelectItem>
              <SelectItem value={Language.HINDI}>Hindi</SelectItem>
              <SelectItem value={Language.ENGLISH}>English</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Response length</Label>
          <Select
            value={aiSettings.responseLength ?? INHERIT}
            onValueChange={(value) =>
              setAiSettings((current) => ({
                ...current,
                responseLength: value === INHERIT ? null : (value as ResponseLength),
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>Inherit</SelectItem>
              <SelectItem value={ResponseLength.SHORT}>Short</SelectItem>
              <SelectItem value={ResponseLength.NORMAL}>Normal</SelectItem>
              <SelectItem value={ResponseLength.DETAILED}>Detailed</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Emoji level</Label>
          <Select
            value={aiSettings.emojiLevel ?? INHERIT}
            onValueChange={(value) =>
              setAiSettings((current) => ({
                ...current,
                emojiLevel: value === INHERIT ? null : (value as EmojiLevel),
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>Inherit</SelectItem>
              <SelectItem value={EmojiLevel.NONE}>None</SelectItem>
              <SelectItem value={EmojiLevel.LOW}>Low</SelectItem>
              <SelectItem value={EmojiLevel.MEDIUM}>Medium</SelectItem>
              <SelectItem value={EmojiLevel.HIGH}>High</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Memory</Label>
          <Select
            value={toTriState(aiSettings.memoryEnabled)}
            onValueChange={(value) =>
              setAiSettings((current) => ({
                ...current,
                memoryEnabled: fromTriState(value),
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>Inherit</SelectItem>
              <SelectItem value="true">On</SelectItem>
              <SelectItem value="false">Off</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Auto-send</Label>
          <Select
            value={toTriState(aiSettings.autoSend)}
            onValueChange={(value) =>
              setAiSettings((current) => ({ ...current, autoSend: fromTriState(value) }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>Inherit</SelectItem>
              <SelectItem value="true">On</SelectItem>
              <SelectItem value="false">Off</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            When on, every new incoming message gets an AI reply generated and sent
            automatically — no approval step, nothing to review first.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="customInstructions">Custom instructions</Label>
          <Textarea
            id="customInstructions"
            className="min-h-16"
            value={aiSettings.customInstructions}
            onChange={(event) =>
              setAiSettings((current) => ({
                ...current,
                customInstructions: event.target.value,
              }))
            }
          />
        </div>

        <Button size="sm" onClick={handleAISettingsSave} disabled={isPending}>
          Save AI overrides
        </Button>
      </div>

      <div className="space-y-3 border-t pt-4">
        <p className="text-xs font-semibold text-muted-foreground">Contact profile</p>
        <div className="space-y-1.5">
          <Label htmlFor="preferredName">Preferred name</Label>
          <Input
            id="preferredName"
            value={profile.preferredName}
            onChange={(event) =>
              setProfile((current) => ({ ...current, preferredName: event.target.value }))
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="relationshipLabel">Relationship</Label>
          <Input
            id="relationshipLabel"
            value={profile.relationshipLabel}
            onChange={(event) =>
              setProfile((current) => ({
                ...current,
                relationshipLabel: event.target.value,
              }))
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="notes">Private notes</Label>
          <Textarea
            id="notes"
            className="min-h-20"
            value={profile.notes}
            onChange={(event) =>
              setProfile((current) => ({ ...current, notes: event.target.value }))
            }
          />
          <p className="text-xs text-muted-foreground">
            Only visible to you — never sent to Instagram.
          </p>
        </div>
        <Button size="sm" onClick={handleProfileSave} disabled={isPending}>
          Save profile
        </Button>
      </div>

      <ConversationMemoryPanel
        conversationId={conversationId}
        initialMemories={memories}
      />
    </div>
  );
}
