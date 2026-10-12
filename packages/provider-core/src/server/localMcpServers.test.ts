// FORK: the user's local stdio MCP servers (~/.config/t3code/mcp-servers.json).
// @effect-diagnostics nodeBuiltinImport:off - fixtures for a synchronous file reader
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { localMcpServers, localMcpServersFor, localMcpServersPath } from "./localMcpServers.ts";

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
});
