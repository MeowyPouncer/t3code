// FORK: the user's local stdio MCP servers reach T3's Cursor agents.
// @effect-diagnostics nodeBuiltinImport:off - fixtures for a synchronous file reader
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { cursorMcpServers, cursorRunMcpServers, makeCursorAgentOptions } from "./adapter.ts";

describe("local MCP servers for Cursor", () => {
  let directory: string;
  const previous = process.env.T3CODE_LOCAL_MCP_SERVERS_FILE;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cursor-local-mcp-"));
    const file = NodePath.join(directory, "mcp-servers.json");
    NodeFS.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { "aihub-workflow": { command: "/opt/aihub/bin/server", args: [] } },
      }),
    );
    process.env.T3CODE_LOCAL_MCP_SERVERS_FILE = file;
  });

  afterEach(() => {
    NodeFS.rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) {
      delete process.env.T3CODE_LOCAL_MCP_SERVERS_FILE;
    } else {
      process.env.T3CODE_LOCAL_MCP_SERVERS_FILE = previous;
    }
  });

  it("go inline beside T3's own server, which keeps its name", () => {
    const threadId = ThreadId.make("thread-cursor-local-mcp");
    expect(cursorMcpServers(undefined)).toBeUndefined();
    expect(cursorRunMcpServers(undefined, threadId, "/workspace", "/projects/aihub")).toEqual({
      "aihub-workflow": {
        type: "stdio",
        command: "/opt/aihub/bin/server",
        args: [],
        cwd: "/workspace",
        // FORK: the server starts with this agent, so it learns the thread and the project's root.
        env: { T3CODE_THREAD_ID: threadId, T3CODE_PROJECT_ROOT: "/projects/aihub" },
      },
    });

    const mcpSession = {
      environmentId: EnvironmentId.make("environment-cursor-local-mcp"),
      threadId,
      providerSessionId: "mcp-session-cursor-local",
      providerInstanceId: ProviderInstanceId.make("cursor"),
      endpoint: "http://127.0.0.1:43124/mcp",
      authorizationHeader: "Bearer t3-token",
      browserToolsAvailable: true,
    };
    const options = makeCursorAgentOptions({
      modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2.5" },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        projectRoot: "/projects/aihub",
      },
      threadId,
      mcpSession,
    });
    expect(Object.keys(options.mcpServers ?? {}).sort()).toEqual(["aihub-workflow", "t3-code"]);
    expect(options.mcpServers?.["t3-code"]).toEqual(cursorMcpServers(mcpSession)?.["t3-code"]);
    expect(options.mcpServers?.["aihub-workflow"]).toMatchObject({
      cwd: "/workspace",
      env: { T3CODE_THREAD_ID: threadId, T3CODE_PROJECT_ROOT: "/projects/aihub" },
    });
  });

  it("change nothing when the file is off", () => {
    process.env.T3CODE_LOCAL_MCP_SERVERS_FILE = "";
    expect(
      cursorRunMcpServers(undefined, ThreadId.make("thread-cursor-no-local"), "/workspace"),
    ).toBeUndefined();
  });
});
