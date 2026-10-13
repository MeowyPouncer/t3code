// FORK: what the night mode adds to every top-level session's instructions while the user is away.
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface NightRulesValue {
  readonly rules: string;
  /** The overseer keeps its own instructions and never gets the night rules. */
  readonly overseerThreadId: ThreadId;
}

/**
 * Shared between NightService, which sets it while a night runs, and RuntimePolicy, which reads
 * it on every turn start. A separate service keeps RuntimePolicy free of the night's own
 * dependencies.
 */
export class NightRules extends Context.Service<
  NightRules,
  {
    readonly current: Effect.Effect<NightRulesValue | null>;
    readonly set: (value: NightRulesValue | null) => Effect.Effect<void>;
  }
>()("t3/night/NightRules") {}

export const layer = Layer.effect(
  NightRules,
  Effect.gen(function* () {
    const value = yield* Ref.make<NightRulesValue | null>(null);
    return NightRules.of({ current: Ref.get(value), set: (next) => Ref.set(value, next) });
  }),
);
