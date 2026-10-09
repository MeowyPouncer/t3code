import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";

const providerToken = "providerTokenWithoutDots";
const instanceId = ProviderInstanceId.make("antigravity");
// A credential minted before the instance was capped.
const providerScope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("environment-mcp-hard-cap"),
  requestNamespace: "provider-session",
  thread: {
    threadId: ThreadId.make("thread-mcp-hard-cap"),
    providerSessionId: "provider-session",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
  issuedAt: 1,
};

const ProbeToolkit = Toolkit.make(
  Tool.make("probe", {
    description: "Reports the caller's capabilities.",
    success: Schema.Struct({ capabilities: Schema.Array(Schema.String) }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
);

const callProbe = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const headers = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${providerToken}`,
  };
  const initialize = yield* httpClient.post("/mcp", {
    headers,
    body: HttpBody.text(
      `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
      "application/json",
    ),
  });
  const response = yield* httpClient.post("/mcp", {
    headers: {
      ...headers,
      "mcp-session-id": initialize.headers["mcp-session-id"]!,
      "mcp-protocol-version": "2025-06-18",
    },
    body: HttpBody.text(
      `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"probe","arguments":{}}}`,
      "application/json",
    ),
  });
  return yield* response.text;
});

const serveProbe = (settingsLayer: Layer.Layer<ServerSettings.ServerSettingsService>) =>
  HttpRouter.serve(
    McpHttpServer.toolkitRegistration(
      ProbeToolkit,
      McpToolAccess.toLayer(ProbeToolkit, {
        probe: McpToolAccess.reads(() =>
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.map((scope) => ({ capabilities: [...scope.capabilities].toSorted() })),
          ),
        ),
      }),
    ).pipe(
      Layer.provideMerge(McpHttpServer.layerMcpTransport),
      Layer.provide(
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          resolve: (token) => Effect.succeed(token === providerToken ? providerScope : undefined),
        }),
      ),
      Layer.provide(settingsLayer),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.build);

it.effect("applies a hard cap set after the credential was minted to the next request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const settingsContext = yield* Layer.build(ServerSettings.layerTest().pipe(Layer.orDie));
      const service = Context.get(settingsContext, ServerSettings.ServerSettingsService);
      yield* serveProbe(Layer.succeedContext(settingsContext));

      expect(yield* callProbe).toContain('["orchestration","pull-requests","worktree"]');
      yield* service.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("antigravity"),
            hardCap: { withheldCapabilities: ["orchestration", "pull-requests"] },
          },
        },
      });
      // Same credential, no new session: the cap holds at once.
      expect(yield* callProbe).toContain('["worktree"]');
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("gives a provider credential no cappable tool when the caps cannot be read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveProbe(
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.fail(
            new ServerSettingsError({ settingsPath: "/settings.json", operation: "read-file" }),
          ),
        }),
      );
      expect(yield* callProbe).toContain('"capabilities":[]');
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
