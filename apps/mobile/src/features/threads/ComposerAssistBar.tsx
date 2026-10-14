// FORK: composer assist above the mobile composer: a blank being answered, a rewrite to revert,
// and the cues on the draft. Tapping a cue opens its note and choices.
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { MobileComposerAssistStatus, MobileComposerCue } from "./useComposerAssist";

const KIND_MARK: Record<MobileComposerCue["kind"], string> = {
  contradiction: "⚠",
  spelling: "✍",
  sentence: "↻",
  ask: "?",
};

function cueLabel(cue: MobileComposerCue): string {
  if (cue.kind === "spelling" && cue.alternatives[0] !== undefined) {
    return `${cue.quote} → ${cue.alternatives[0]}`;
  }
  return cue.note.length > 0 ? cue.note : cue.quote;
}

export function ComposerAssistBar(props: {
  readonly status: MobileComposerAssistStatus | null;
  readonly cues: ReadonlyArray<MobileComposerCue>;
  readonly onChoose: (cue: MobileComposerCue, choice: string) => void;
  readonly onDismiss: (cue: MobileComposerCue) => void;
  readonly onRevert: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = props.cues.find((cue) => cue.id === openId) ?? null;
  if (props.status === null && props.cues.length === 0) return null;
  return (
    <View className="gap-1.5 px-4 pb-2">
      {props.status !== null ? (
        <View className="flex-row items-center gap-2">
          {props.status.kind === "working" ? <ActivityIndicator size="small" /> : null}
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={2}>
            {props.status.kind === "working"
              ? "Claude is answering the blank…"
              : props.status.kind === "rewritten"
                ? "Claude rewrote the draft."
                : props.status.text}
          </Text>
          {props.status.kind === "rewritten" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Revert the rewrite"
              hitSlop={8}
              onPress={props.onRevert}
              className="min-h-8 justify-center px-1 active:opacity-70"
            >
              <Text className="font-t3-medium text-xs text-primary">Revert</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {props.cues.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
        >
          <View className="flex-row gap-1.5">
            {props.cues.map((cue) => (
              <Pressable
                key={cue.id}
                accessibilityRole="button"
                accessibilityState={{ expanded: cue.id === openId }}
                onPress={() => setOpenId((current) => (current === cue.id ? null : cue.id))}
                className={
                  cue.id === openId
                    ? "max-w-64 flex-row items-center gap-1 rounded-full bg-subtle px-2.5 py-1"
                    : "max-w-64 flex-row items-center gap-1 rounded-full border border-border-subtle px-2.5 py-1 active:opacity-70"
                }
              >
                <Text className="text-xs text-foreground-muted">{KIND_MARK[cue.kind]}</Text>
                <Text className="min-w-0 shrink text-xs text-foreground" numberOfLines={1}>
                  {cueLabel(cue)}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      ) : null}
      {open !== null ? (
        <View className="gap-1 rounded-xl border border-border-subtle p-2">
          {open.note.length > 0 ? (
            <Text className="text-xs text-foreground">{open.note}</Text>
          ) : null}
          {[open.original, ...open.alternatives].map((choice, index) =>
            choice === open.quote && index > 0 ? null : (
              <Pressable
                key={`${index === 0 ? "original" : "choice"}:${choice}`}
                accessibilityRole="button"
                disabled={choice === open.quote}
                onPress={() => props.onChoose(open, choice)}
                className="rounded-lg px-2 py-1.5 active:opacity-70 disabled:opacity-50"
              >
                <Text className="text-xs text-foreground">
                  {index === 0 ? "As written: " : ""}
                  {choice}
                </Text>
              </Pressable>
            ),
          )}
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              props.onDismiss(open);
              setOpenId(null);
            }}
            className="self-end px-2 py-1 active:opacity-70"
          >
            <Text className="font-t3-medium text-xs text-primary">Dismiss</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
