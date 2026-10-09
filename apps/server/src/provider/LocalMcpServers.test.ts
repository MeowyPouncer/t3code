// FORK: the user's local stdio MCP servers reach T3's Cursor runs.
// @effect-diagnostics nodeBuiltinImport:off - fixtures for a synchronous file reader
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import {
  cursorMcpServers,
  cursorRunMcpServers,
  makeCursorAgentOptions,
} from "../orchestration-v2/Adapters/CursorAdapterV2.ts";
import { localMcpServers, localMcpServersFor, localMcpServersPath } from "./LocalMcpServers.ts";

describe("local MCP servers", () => {
  let directory: string;
  let file: string;
  const previous = process.env.T3CODE_LOCAL_MCP_SERVERS_FILE;

  let writes = 0;
  const write = (value: unknown) => {
    NodeFS.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    // A distinct mtime for each write, so the cache re-reads.
    writes += 1;
    const seconds = NodeFS.statSync(file).mtimeMs / 1000 + writes * 10;
    NodeFS.utimesSync(file, seconds, seconds);
  };

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-local-mcp-"));
    file = NodePath.join(directory, "mcp-servers.json");
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

  it("reads the path from the environment, empty meaning off", () => {
    expect(localMcpServersPath({ T3CODE_LOCAL_MCP_SERVERS_FILE: " /x/servers.json " })).toBe(
      "/x/servers.json",
    );
    expect(localMcpServersPath({})).toBe(
      NodePath.join(NodeOS.homedir(), ".config", "t3code", "mcp-servers.json"),
    );
    expect(localMcpServers("")).toEqual({});
  });

  it("is empty when the file is missing or not JSON", () => {
    expect(localMcpServers()).toEqual({});
    write("{ not json");
    expect(localMcpServers()).toEqual({});
  });

  it("keeps well-formed stdio servers and skips the rest", () => {
    write({
      mcpServers: {
        "aihub-workflow": { command: "/opt/aihub/bin/server", args: [] },
        withEnv: { type: "stdio", command: "node", args: ["s.js"], env: { A: "1" }, cwd: "/srv" },
        "t3-code": { command: "/evil" },
        remote: { url: "https://example.invalid/mcp" },
        httpTyped: { type: "http", command: "x" },
        badArgs: { command: "x", args: [1] },
        badEnv: { command: "x", env: { A: 1 } },
        "bad name": { command: "x" },
        empty: { command: " " },
      },
    });
    expect(localMcpServers()).toEqual({
      "aihub-workflow": { type: "stdio", command: "/opt/aihub/bin/server", args: [] },
      withEnv: { type: "stdio", command: "node", args: ["s.js"], env: { A: "1" }, cwd: "/srv" },
    });
  });

  it("re-reads after the file changes", () => {
    write({ mcpServers: { one: { command: "a" } } });
    expect(Object.keys(localMcpServers())).toEqual(["one"]);
    write({ mcpServers: { two: { command: "b" } } });
    expect(Object.keys(localMcpServers())).toEqual(["two"]);
  });

  it("starts each server in the thread's cwd unless it names its own", () => {
    write({ mcpServers: { plain: { command: "a" }, pinned: { command: "b", cwd: "/pinned" } } });
    expect(localMcpServersFor("/work/tree")).toEqual({
      plain: { type: "stdio", command: "a", cwd: "/work/tree" },
      pinned: { type: "stdio", command: "b", cwd: "/pinned" },
    });
    expect(localMcpServersFor(null).plain).toEqual({ type: "stdio", command: "a" });
  });

  it("goes inline to Cursor beside T3's own server, which keeps its name", () => {
    write({ mcpServers: { "aihub-workflow": { command: "/opt/aihub/bin/server", args: [] } } });
    const threadId = ThreadId.make("thread-cursor-local-mcp");
    expect(cursorMcpServers(threadId)).toBeUndefined();
    expect(cursorRunMcpServers(threadId, "/workspace", "/projects/aihub")).toEqual({
      "aihub-workflow": {
        type: "stdio",
        command: "/opt/aihub/bin/server",
        args: [],
        cwd: "/workspace",
        // FORK: the server starts in this run, so it learns the thread and the project's root.
        env: { T3CODE_THREAD_ID: threadId, T3CODE_PROJECT_ROOT: "/projects/aihub" },
      },
    });

    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("environment-cursor-local-mcp"),
      threadId,
      providerSessionId: "mcp-session-cursor-local",
      providerInstanceId: ProviderInstanceId.make("cursor"),
      endpoint: "http://127.0.0.1:43124/mcp",
      authorizationHeader: "Bearer t3-token",
      browserToolsAvailable: true,
    });
    try {
      const options = makeCursorAgentOptions({
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2.5" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
          projectRoot: "/projects/aihub",
        },
        threadId,
      });
      expect(Object.keys(options.mcpServers ?? {}).sort()).toEqual(["aihub-workflow", "t3-code"]);
      expect(options.mcpServers?.["t3-code"]).toEqual(cursorMcpServers(threadId)?.["t3-code"]);
      expect(options.mcpServers?.["aihub-workflow"]).toMatchObject({
        cwd: "/workspace",
        env: { T3CODE_THREAD_ID: threadId, T3CODE_PROJECT_ROOT: "/projects/aihub" },
      });
    } finally {
      McpProviderSession.clearMcpProviderSession(threadId);
    }
  });

  it("changes nothing when the file is off", () => {
    process.env.T3CODE_LOCAL_MCP_SERVERS_FILE = "";
    expect(
      cursorRunMcpServers(ThreadId.make("thread-cursor-no-local"), "/workspace"),
    ).toBeUndefined();
  });
});
