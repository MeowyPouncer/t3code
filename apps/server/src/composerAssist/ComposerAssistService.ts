// FORK: composer assist, after OpenCues. A draft ending in " _" is rewritten or filled in, and a
// pause in typing brings cues. This service picks the Claude account, gives the model the thread's
// recent turns, its decisions and the project's AGENTS.md rules, and checks what comes back. The
// Claude process itself lives with the provider instance (Drivers/ClaudeComposerAssist.ts).
// Drafts are private: nothing here logs their text.
import {
  type ComposerAssistActivity,
  type ComposerAssistBlankResult,
  type ComposerAssistCuesResult,
  ComposerAssistError,
  type ComposerAssistRequest,
  type ComposerAssistRunRequest,
  type ComposerAssistRunResult,
  type ComposerAssistStatus,
  type ComposerAssistStatusRequest,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import type { ProviderComposerAssist } from "@t3tools/provider-core/server/driver";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
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
const MAX_RECENT_ACTIVITY = 5;

export class ComposerAssistService extends Context.Service<
  ComposerAssistService,
  {
    readonly blank: (
      input: ComposerAssistRequest,
    ) => Effect.Effect<ComposerAssistBlankResult, ComposerAssistError>;
    readonly cues: (
      input: ComposerAssistRequest,
    ) => Effect.Effect<ComposerAssistCuesResult, ComposerAssistError>;
    /** What the RPC calls: one of the three below, by `operation`. */
    readonly run: (
      input: ComposerAssistRunRequest,
    ) => Effect.Effect<ComposerAssistRunResult, ComposerAssistError>;
    /**
     * What it has done since the server started and who would answer a draft now; with a project,
     * also the rules its contradiction cues check against (`readRules` works them out when unknown).
     */
    readonly status: (
      input: ComposerAssistStatusRequest,
    ) => Effect.Effect<ComposerAssistStatus, ComposerAssistError>;
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

/** The `claude --model` alias for the setting; an empty setting is Haiku. */
export function modelOf(settings: { readonly model: string }): string {
  return settings.model === "" ? "haiku" : settings.model;
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
  const startedAtIso = DateTime.formatIso(yield* DateTime.now);
  const counts = {
    blank: { requests: 0, failures: 0 },
    cues: { requests: 0, failures: 0 },
  };
  /** The newest requests that asked the model, newest first. */
  let recent: ReadonlyArray<ComposerAssistActivity> = [];

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

  /** Counts a request that asked the model, for the status in Settings. A dropped one is not counted. */
  const timed = <A>(
    operation: "blank" | "cues",
    effect: Effect.Effect<A, ComposerAssistError>,
  ): Effect.Effect<A, ComposerAssistError> =>
    Effect.gen(function* () {
      const startedMs = yield* Clock.currentTimeMillis;
      const record = (detail: string | undefined) =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          counts[operation].requests += 1;
          if (detail !== undefined) counts[operation].failures += 1;
          recent = [
            {
              operation,
              ok: detail === undefined,
              durationMs: nowMs - startedMs,
              at: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
              ...(detail === undefined ? {} : { detail }),
            },
            ...recent,
          ].slice(0, MAX_RECENT_ACTIVITY);
        });
      return yield* effect.pipe(
        Effect.tap(() => record(undefined)),
        Effect.tapError((error) => record(error.detail)),
      );
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
    model: string,
  ) =>
    assistant
      .complete({ system: COMPOSER_ASSIST_SYSTEM_PROMPT, task, timeoutMs, model })
      .pipe(
        Effect.mapError((cause) => new ComposerAssistError({ operation, detail: cause.detail })),
      );

  const decisionsFor = (
    assistant: ProviderComposerAssist,
    model: string,
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
                  yield* complete(
                    assistant,
                    decisionsTask(transcript),
                    DISTILL_TIMEOUT_MS,
                    "cues",
                    model,
                  ),
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

  /** The rules file cues use: AGENTS.md, else CLAUDE.md, and which version of it this is. */
  const rulesFile = (root: string) =>
    Effect.gen(function* () {
      for (const fileName of RULE_FILES) {
        const filePath = path.join(root, fileName);
        const content = yield* fs.readFileString(filePath).pipe(Effect.option);
        if (Option.isNone(content) || content.value.trim().length === 0) continue;
        return {
          fileName,
          filePath,
          content: content.value,
          key: `${filePath}:${contentHash(content.value)}`,
        };
      }
      return null;
    });

  /**
   * The rules in a project's rules file. An older version's rules serve while the new ones are
   * worked out, unless `wait`: then a changed file is read before this returns.
   */
  const rulesFor = (assistant: ProviderComposerAssist, model: string, root: string, wait = false) =>
    Effect.gen(function* () {
      const file = yield* rulesFile(root);
      if (file === null) return { fileName: null, rules: [] as ReadonlyArray<string> };
      const { fileName, filePath, content, key } = file;
      const known = rulesByKey.get(key);
      if (known !== undefined) {
        latestRulesKey.set(filePath, key);
        return { fileName, rules: known };
      }
      const staleKey = latestRulesKey.get(filePath);
      const stale = staleKey === undefined ? undefined : rulesByKey.get(staleKey);
      const refresh = once(
        `rules:${key}`,
        Effect.gen(function* () {
          const rules = parseListReply(
            yield* complete(
              assistant,
              rulesTask({ fileName, content: content.slice(0, RULES_SOURCE_CHARS) }),
              DISTILL_TIMEOUT_MS,
              "cues",
              model,
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
      if (stale !== undefined && !wait) {
        yield* refresh.pipe(Effect.forkIn(scope));
        return { fileName, rules: stale };
      }
      return { fileName, rules: yield* refresh };
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
      const reply = yield* timed(
        "blank",
        complete(
          assistant,
          blankTask({
            text: input.text.replace(/\s+$/, ""),
            thread,
            language: settings.language === "" ? null : settings.language,
          }),
          BLANK_TIMEOUT_MS,
          "blank",
          modelOf(settings),
        ),
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
      const model = modelOf(settings);
      // Cues nobody asked for never take the last of a usage window.
      if (!(yield* assistant.roomForBackground)) return { cues: [] };
      let decisions: ReadonlyArray<string> = [];
      let rules: ReadonlyArray<string> = [];
      if (kinds.includes("contradiction")) {
        if (input.threadId !== undefined && shell !== null) {
          decisions = yield* decisionsFor(assistant, model, input.threadId, shell.latestRunId);
        }
        const root = yield* projectRoot(shell, input.projectId);
        if (root !== null) {
          rules = (yield* rulesFor(assistant, model, root)).rules.filter(
            (rule) => !settings.disabledRules.includes(rule),
          );
        }
      }
      const today = DateTime.toParts(
        DateTime.setZone(yield* DateTime.now, DateTime.zoneMakeLocal()),
      );
      const reply = yield* timed(
        "cues",
        complete(
          assistant,
          cuesTask({
            text,
            kinds,
            audit: settings.auditor,
            decisions,
            rules,
            calendar: renderCalendar({ year: today.year, month: today.month, day: today.day }),
            language: settings.cueLanguage === "" ? null : settings.cueLanguage,
          }),
          CUES_TIMEOUT_MS,
          "cues",
          model,
        ),
      );
      const parsed = parseCuesReply(reply, text, kinds, settings.auditor);
      return {
        cues: parsed.cues.map((cue) => ({ ...cue, alternatives: [...cue.alternatives] })),
        ...(parsed.audit === null ? {} : { audit: parsed.audit }),
      };
    },
  );

  /** The rules cues use for a project: the known ones, or, when asked to, freshly read ones. */
  const projectRules = (input: ComposerAssistStatusRequest & { readonly projectId: ProjectId }) =>
    Effect.gen(function* () {
      const settings = yield* settingsOf;
      const root = yield* projectRoot(null, input.projectId);
      const file = root === null ? null : yield* rulesFile(root);
      if (root === null || file === null) return { fileName: null, rules: [] };
      const known = rulesByKey.get(file.key);
      if (known !== undefined) return { fileName: file.fileName, rules: known };
      if (input.readRules !== true) {
        const staleKey = latestRulesKey.get(file.filePath);
        return {
          fileName: file.fileName,
          rules: staleKey === undefined ? null : (rulesByKey.get(staleKey) ?? null),
        };
      }
      const { assistant } = yield* assistantFor(
        { projectId: input.projectId, text: "" },
        settings.instanceId,
        "cues",
      );
      const read = yield* rulesFor(assistant, modelOf(settings), root, true);
      return { fileName: read.fileName, rules: read.rules };
    });

  const status: ComposerAssistService["Service"]["status"] = Effect.fn(
    "ComposerAssistService.status",
  )(function* (input) {
    const settings = yield* settingsOf;
    const chosen = pickComposerAssistInstance(
      yield* registry.listInstances,
      settings.instanceId,
      undefined,
    );
    const rules =
      input.projectId === undefined
        ? null
        : yield* projectRules({ ...input, projectId: input.projectId });
    return {
      model: modelOf(settings),
      account:
        chosen === null
          ? null
          : { instanceId: chosen.instanceId, label: chosen.displayName ?? chosen.instanceId },
      followsThread: settings.instanceId === "",
      cuesPaused:
        chosen?.composerAssist === undefined
          ? false
          : !(yield* chosen.composerAssist.roomForBackground),
      blanks: { ...counts.blank },
      cues: { ...counts.cues },
      recent: [...recent],
      since: startedAtIso,
      ...(rules === null ? {} : { projectRules: rules }),
    };
  });

  const run: ComposerAssistService["Service"]["run"] = (input) => {
    switch (input.operation) {
      case "blank":
        return blank(input).pipe(Effect.map((result) => ({ operation: "blank", blank: result })));
      case "cues":
        return cues(input).pipe(Effect.map((result) => ({ operation: "cues", cues: result })));
      case "status":
        return status(input).pipe(
          Effect.map((result) => ({ operation: "status", status: result })),
        );
    }
  };

  return ComposerAssistService.of({ blank, cues, status, run });
});

export const layer = Layer.effect(ComposerAssistService, make);
