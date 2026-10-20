import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as TextGenerationOperations from "./textGenerationOperations.ts";

describe("composer assist text generation", () => {
  it.effect("runs without investigation and preserves the selected model, options and reply", () =>
    Effect.gen(function* () {
      const requests: Array<TextGenerationOperations.Request<Schema.Top>> = [];
      const generation = TextGenerationOperations.fromRunner("test", (request) => {
        requests.push(request);
        return TextGenerationOperations.decodeJsonReply(
          request,
          "test",
          JSON.stringify({
            text: "<verdict>REWRITE</verdict>\n<text>Fix the crash.</text>",
          }),
        );
      });
      const modelSelection = {
        instanceId: ProviderInstanceId.make("cursor-personal"),
        model: "gemini-4-argon",
        options: [{ id: "reasoning_effort", value: "high" }],
      };
      const result = yield* generation.generateComposerAssist({
        cwd: "/isolated-composer-assist",
        system: "Help edit the draft.",
        task: "Shorten the draft without losing ⟦1⟧.",
        modelSelection,
      });
      expect(result).toBe("<verdict>REWRITE</verdict>\n<text>Fix the crash.</text>");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.modelSelection).toEqual(modelSelection);
      expect(requests[0]?.investigate).toBeUndefined();
      expect(requests[0]?.prompt).toContain("Help edit the draft.");
      expect(requests[0]?.prompt).toContain("Shorten the draft without losing ⟦1⟧.");
    }),
  );
});
