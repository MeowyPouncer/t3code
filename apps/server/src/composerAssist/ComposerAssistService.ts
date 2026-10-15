// FORK: composer assist, after OpenCues. A draft ending in " _" is rewritten or filled in, and a
// pause in typing brings cues. This service picks the Claude account, gives the model the thread's
// recent turns, its decisions and the project's AGENTS.md rules, and checks what comes back. The
// Claude process itself lives with the provider instance (Drivers/ClaudeComposerAssist.ts).
// Drafts are private: nothing here logs their text.
import {
  type ComposerAssistBlankResult,
  type ComposerAssistCuesResult,
  ComposerAssistError,
  type ComposerAssistRequest,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import type { ProviderComposerAssist } from "@t3tools/provider-core/server/driver";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { parseBlankReply, parseCuesReply, parseListReply } from "./composerAssistParse.ts";
import {
  blankTask,
  COMPOSER_ASSIST_SYSTEM_PROMPT,
  type ComposerAssistCueKindName,
  type ComposerAssistThreadContext,
  cuesTask,
  decisionsTask,
  renderCalendar,
  rulesTask,
} from "./composerAssistPrompts.ts";

const BLANK_TIMEOUT_MS = 30_000;
const CUES_TIMEOUT_MS = 20_000;
const DISTILL_TIMEOUT_MS = 60_000;
/** Shorter drafts have nothing worth a cue yet; longer ones are mostly pasted logs or code. */
const MIN_CUE_DRAFT_CHARS = 12;
const MAX_CUE_DRAFT_CHARS = 12_000;
/** The newest timeline items read for a thread's context: enough for its recent decisions. */
const TIMELINE_TAIL_ITEMS = 160;
const BLANK_CONTEXT_MESSAGES = 2;
const BLANK_CONTEXT_CHARS = 1_500;
const TRANSCRIPT_MESSAGE_CHARS = 4_000;
const TRANSCRIPT_CHARS = 24_000;
const RULES_SOURCE_CHARS = 60_000;
const RULE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
/** A distillation that failed is not retried on every pause. */
const FAILED_DISTILL_BACKOFF_MS = 60_000;
const MAX_CACHED_THREADS = 200;
const MAX_PERSISTED_RULE_SETS = 64;

export class ComposerAssistService extends Context.Service<
  ComposerAssistService,
  {
    readonly blank: (
      input: ComposerAssistRequest,
    ) => Effect.Effect<ComposerAssistBlankResult, ComposerAssistError>;
    readonly cues: (
      input: ComposerAssistRequest,
    ) => Effect.Effect<ComposerAssistCuesResult, ComposerAssistError>;
  }
>()("t3/composerAssist/ComposerAssistService") {}

export function cueKindsFor(settings: {
  readonly contradictions: boolean;
  readonly spelling: boolean;
  readonly sentences: boolean;
  readonly askCues: boolean;
}): ReadonlyArray<ComposerAssistCueKindName> {
  return [
    ...(settings.contradictions ? (["contradiction"] as const) : []),
    ...(settings.spelling ? (["spelling"] as const) : []),
    ...(settings.sentences ? (["sentence"] as const) : []),
    ...(settings.askCues ? (["ask"] as const) : []),
  ];
}

/**
 * The thread's own Claude account when it runs on Claude, so two accounts never work at once;
 * otherwise the first Claude instance in settings order. A configured instance is used or nothing.
 */
export function pickComposerAssistInstance<
  T extends {
    readonly instanceId: ProviderInstanceId;
    readonly enabled: boolean;
    readonly composerAssist?: ProviderComposerAssist;
  },
>(instances: ReadonlyArray<T>, configured: string, preferred: ProviderInstanceId | undefined) {
  const usable = instances.filter(
    (instance) => instance.enabled && instance.composerAssist !== undefined,
  );
  if (configured.length > 0) {
    return usable.find((instance) => instance.instanceId === configured) ?? null;
  }
  return usable.find((instance) => instance.instanceId === preferred) ?? usable[0] ?? null;
}

export interface ThreadMessage {
  readonly role: "user" | "agent";
  readonly text: string;
}

/** The newest messages that fit, oldest first, each cut to its newest part. */
export function renderTranscript(messages: ReadonlyArray<ThreadMessage>): string {
  const lines: string[] = [];
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const text = message.text.trim().slice(-TRANSCRIPT_MESSAGE_CHARS);
    const line = `${message.role === "user" ? "USER" : "AGENT"}: ${text}`;
    if (total + line.length > TRANSCRIPT_CHARS && lines.length > 0) break;
    lines.push(line);
    total += line.length;
  }
  return lines.toReversed().join("\n\n");
}

/** FNV-1a: tells two versions of a rules file apart without keeping either. */
function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

const PersistedRules = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Array(Schema.String)),
);
const decodePersistedRules = Schema.decodeUnknownEffect(PersistedRules);
const encodePersistedRules = Schema.encodeEffect(PersistedRules);

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;

  const rulesPath = path.join(config.stateDir, "composer-assist-rules.json");
  /** Distilled rules by `<file path>:<content hash>`, kept across restarts. */
  const rulesByKey = new Map<string, ReadonlyArray<string>>(
    Object.entries(
      yield* fs.readFileString(rulesPath).pipe(
        Effect.flatMap(decodePersistedRules),
        Effect.orElseSucceed(() => ({})),
      ),
    ),
  );
  /** The newest rules key seen per file, so a changed file keeps its old rules until new ones exist. */
  const latestRulesKey = new Map<string, string>();
  /** Decisions per thread, with the run they were read after. */
  const decisionsByThread = new Map<
    ThreadId,
    { readonly runId: string | null; readonly decisions: ReadonlyArray<string> }
  >();
  const inflight = new Map<string, Deferred.Deferred<ReadonlyArray<string>>>();
  const failedAtMs = new Map<string, number>();

  const persistRules = Effect.suspend(() => {
    const entries = [...rulesByKey.entries()].slice(-MAX_PERSISTED_RULE_SETS);
    return encodePersistedRules(Object.fromEntries(entries)).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: rulesPath, contents: `${contents}\n` }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catch((cause) =>
        Effect.logWarning("Could not save composer assist rules.", { cause }),
      ),
    );
  });

  /**
   * One distillation per key at a time, run outside the request: a request the client drops
   * (a newer pause replaces it) does not throw the work away for the next one.
   */
  const once = (
    key: string,
    compute: Effect.Effect<ReadonlyArray<string>, ComposerAssistError>,
  ): Effect.Effect<ReadonlyArray<string>> =>
    Effect.gen(function* () {
      const failed = failedAtMs.get(key);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      if (failed !== undefined && nowMs - failed < FAILED_DISTILL_BACKOFF_MS) return [];
      let pending = inflight.get(key);
      if (pending === undefined) {
        const created = yield* Deferred.make<ReadonlyArray<string>>();
        inflight.set(key, created);
        yield* compute.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Composer assist could not distil its context.", { cause }).pipe(
              Effect.andThen(Effect.sync(() => failedAtMs.set(key, nowMs))),
              Effect.as([] as ReadonlyArray<string>),
            ),
          ),
          Effect.flatMap((value) => Deferred.succeed(created, value)),
          Effect.ensuring(Effect.sync(() => inflight.delete(key))),
          Effect.forkIn(scope),
        );
        pending = created;
      }
      return yield* Deferred.await(pending);
    });

  const settingsOf = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.composerAssist),
    Effect.mapError(
      (cause) =>
        new ComposerAssistError({
          operation: "cues",
          detail: `Could not read settings: ${cause.message}`,
        }),
    ),
  );

  const threadShell = (threadId: ThreadId | undefined) =>
    threadId === undefined
      ? Effect.succeed(null)
      : threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));

  /** The thread's newest messages, oldest first: what the user and the agent said, no tool output. */
  const threadMessages = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const head = yield* projections.getTimelinePage(threadId, { view: "messages", limit: 0 });
      const page = yield* projections.getTimelinePage(threadId, {
        view: "messages",
        afterPosition: Math.max(-1, head.totalItems - TIMELINE_TAIL_ITEMS - 1),
        limit: TIMELINE_TAIL_ITEMS,
      });
      const messages: ThreadMessage[] = [];
      for (const { item } of page.items) {
        if (item.type === "user_message") {
          // Slash commands and T3's own idle compaction say nothing about the work.
          if (item.idleCompaction === true || item.text.trim().startsWith("/")) continue;
          messages.push({ role: "user", text: item.text });
        } else if (item.type === "assistant_message" && !item.streaming) {
          messages.push({ role: "agent", text: item.text });
        }
      }
      return messages;
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<ThreadMessage> => []));

  const assistantFor = (
    input: ComposerAssistRequest,
    configured: string,
    operation: "blank" | "cues",
  ) =>
    Effect.gen(function* () {
      const shell = yield* threadShell(input.threadId);
      const chosen = pickComposerAssistInstance(
        yield* registry.listInstances,
        configured,
        input.instanceId ?? shell?.modelSelection.instanceId,
      );
      if (chosen?.composerAssist === undefined) {
        return yield* new ComposerAssistError({
          operation,
          detail:
            configured.length > 0
              ? `The Claude provider "${configured}" chosen for composer assist is not available.`
              : "Composer assist needs a Claude provider.",
        });
      }
      return { assistant: chosen.composerAssist, shell };
    });

  const complete = (
    assistant: ProviderComposerAssist,
    task: string,
    timeoutMs: number,
    operation: "blank" | "cues",
  ) =>
    assistant
      .complete({ system: COMPOSER_ASSIST_SYSTEM_PROMPT, task, timeoutMs })
      .pipe(
        Effect.mapError((cause) => new ComposerAssistError({ operation, detail: cause.detail })),
      );

  const decisionsFor = (
    assistant: ProviderComposerAssist,
    threadId: ThreadId,
    runId: string | null,
  ) =>
    Effect.gen(function* () {
      const cached = decisionsByThread.get(threadId);
      if (cached !== undefined && cached.runId === runId) return cached.decisions;
      const refresh = once(
        `decisions:${threadId}:${runId ?? "none"}`,
        Effect.gen(function* () {
          const transcript = renderTranscript(yield* threadMessages(threadId));
          const decisions =
            transcript.length === 0
              ? []
              : parseListReply(
                  yield* complete(assistant, decisionsTask(transcript), DISTILL_TIMEOUT_MS, "cues"),
                  "decisions",
                  12,
                );
          decisionsByThread.delete(threadId);
          decisionsByThread.set(threadId, { runId, decisions });
          if (decisionsByThread.size > MAX_CACHED_THREADS) {
            const oldest = decisionsByThread.keys().next().value;
            if (oldest !== undefined) decisionsByThread.delete(oldest);
          }
          return decisions;
        }),
      );
      // Decisions from an earlier turn serve until the new ones are ready.
      if (cached !== undefined) {
        yield* refresh.pipe(Effect.forkIn(scope));
        return cached.decisions;
      }
      return yield* refresh;
    });

  const rulesFor = (assistant: ProviderComposerAssist, root: string) =>
    Effect.gen(function* () {
      for (const fileName of RULE_FILES) {
        const filePath = path.join(root, fileName);
        const content = yield* fs.readFileString(filePath).pipe(Effect.option);
        if (Option.isNone(content) || content.value.trim().length === 0) continue;
        const key = `${filePath}:${contentHash(content.value)}`;
        const known = rulesByKey.get(key);
        if (known !== undefined) {
          latestRulesKey.set(filePath, key);
          return known;
        }
        const staleKey = latestRulesKey.get(filePath);
        const stale = staleKey === undefined ? undefined : rulesByKey.get(staleKey);
        const refresh = once(
          `rules:${key}`,
          Effect.gen(function* () {
            const rules = parseListReply(
              yield* complete(
                assistant,
                rulesTask({ fileName, content: content.value.slice(0, RULES_SOURCE_CHARS) }),
                DISTILL_TIMEOUT_MS,
                "cues",
              ),
              "rules",
              24,
            );
            if (staleKey !== undefined) rulesByKey.delete(staleKey);
            rulesByKey.set(key, rules);
            latestRulesKey.set(filePath, key);
            yield* persistRules;
            return rules;
          }),
        );
        if (stale !== undefined) {
          yield* refresh.pipe(Effect.forkIn(scope));
          return stale;
        }
        return yield* refresh;
      }
      return [] as ReadonlyArray<string>;
    });

  const projectRoot = (
    shell: {
      readonly worktreePath: string | null;
      readonly projectId: ComposerAssistRequest["projectId"];
    } | null,
    projectId: ComposerAssistRequest["projectId"],
  ) =>
    Effect.gen(function* () {
      if (shell?.worktreePath) return shell.worktreePath;
      const id = shell?.projectId ?? projectId;
      if (id === undefined) return null;
      const project = yield* projects.get(id).pipe(Effect.orElseSucceed(() => Option.none()));
      return Option.isSome(project) ? project.value.workspaceRoot : null;
    });

  const blank: ComposerAssistService["Service"]["blank"] = Effect.fn("ComposerAssistService.blank")(
    function* (input) {
      const settings = yield* settingsOf;
      if (!settings.blanks) {
        return { _tag: "none" as const, reason: "Blanks are off in Settings." };
      }
      if (!/(?:^|\s)_\s*$/.test(input.text)) {
        return { _tag: "none" as const, reason: "The draft does not end with a _." };
      }
      if (input.text.replace(/\s*_\s*$/, "").trim().length === 0) {
        return { _tag: "none" as const, reason: "Write something before the _." };
      }
      const { assistant, shell } = yield* assistantFor(input, settings.instanceId, "blank");
      let thread: ComposerAssistThreadContext | null = null;
      if (input.threadId !== undefined) {
        const recent = (yield* threadMessages(input.threadId)).slice(-BLANK_CONTEXT_MESSAGES);
        thread = {
          title: shell?.title ?? null,
          messages: recent.map((message) => ({
            role: message.role,
            text: message.text.trim().slice(-BLANK_CONTEXT_CHARS),
          })),
        };
      }
      const reply = yield* complete(
        assistant,
        blankTask({
          text: input.text.replace(/\s+$/, ""),
          thread,
          language: settings.language === "" ? null : settings.language,
        }),
        BLANK_TIMEOUT_MS,
        "blank",
      );
      const outcome = parseBlankReply(reply, input.text.replace(/\s+$/, ""));
      yield* Effect.logDebug("Composer assist blank answered.", { outcome: outcome.kind });
      switch (outcome.kind) {
        case "rewrite":
          return { _tag: "rewrite" as const, text: outcome.text };
        case "fill":
          return { _tag: "fill" as const, text: outcome.text };
        case "none":
          return { _tag: "none" as const, reason: outcome.reason };
      }
    },
  );

  const cues: ComposerAssistService["Service"]["cues"] = Effect.fn("ComposerAssistService.cues")(
    function* (input) {
      const settings = yield* settingsOf;
      const kinds = cueKindsFor(settings);
      const text = input.text;
      if (kinds.length === 0 && !settings.auditor) return { cues: [] };
      if (text.trim().length < MIN_CUE_DRAFT_CHARS || text.length > MAX_CUE_DRAFT_CHARS) {
        return { cues: [] };
      }
      const { assistant, shell } = yield* assistantFor(input, settings.instanceId, "cues");
      // Cues nobody asked for never take the last of a usage window.
      if (!(yield* assistant.roomForBackground)) return { cues: [] };
      let decisions: ReadonlyArray<string> = [];
      let rules: ReadonlyArray<string> = [];
      if (kinds.includes("contradiction")) {
        if (input.threadId !== undefined && shell !== null) {
          decisions = yield* decisionsFor(assistant, input.threadId, shell.latestRunId);
        }
        const root = yield* projectRoot(shell, input.projectId);
        if (root !== null) rules = yield* rulesFor(assistant, root);
      }
      const today = DateTime.toParts(
        DateTime.setZone(yield* DateTime.now, DateTime.zoneMakeLocal()),
      );
      const reply = yield* complete(
        assistant,
        cuesTask({
          text,
          kinds,
          audit: settings.auditor,
          decisions,
          rules,
          calendar: renderCalendar({ year: today.year, month: today.month, day: today.day }),
        }),
        CUES_TIMEOUT_MS,
        "cues",
      );
      const parsed = parseCuesReply(reply, text, kinds, settings.auditor);
      return {
        cues: parsed.cues.map((cue) => ({ ...cue, alternatives: [...cue.alternatives] })),
        ...(parsed.audit === null ? {} : { audit: parsed.audit }),
      };
    },
  );

  return ComposerAssistService.of({ blank, cues });
});

export const layer = Layer.effect(ComposerAssistService, make);
