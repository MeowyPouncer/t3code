// FORK: stdio MCP servers the user lists for providers T3 hands its own MCP config (Cursor).
// @effect-diagnostics nodeBuiltinImport:off - a small synchronous config reader, like RuntimeInstructions
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** FORK: an MCP server T3 passes inline, launched over stdio. */
export interface LocalStdioMcpServer {
  readonly type: "stdio";
  readonly command: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
}

/** FORK: T3's own server keeps its name; a local entry cannot take it. */
const RESERVED_NAME = "t3-code";
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

let localMcpServersCache:
  | { path: string; mtimeMs: number; servers: Record<string, LocalStdioMcpServer> }
  | undefined;

/** FORK: `T3CODE_LOCAL_MCP_SERVERS_FILE` (empty turns it off), else `~/.config/t3code/mcp-servers.json`. */
export function localMcpServersPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.T3CODE_LOCAL_MCP_SERVERS_FILE;
  return configured !== undefined
    ? configured.trim()
    : NodePath.join(NodeOS.homedir(), ".config", "t3code", "mcp-servers.json");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function stdioServer(value: unknown): LocalStdioMcpServer | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  if (entry.type !== undefined && entry.type !== "stdio") {
    return undefined;
  }
  if (typeof entry.command !== "string" || entry.command.trim() === "") {
    return undefined;
  }
  if (
    entry.args !== undefined &&
    !(Array.isArray(entry.args) && entry.args.every((item) => typeof item === "string"))
  ) {
    return undefined;
  }
  if (entry.env !== undefined && !isStringRecord(entry.env)) {
    return undefined;
  }
  if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
    return undefined;
  }
  return {
    type: "stdio",
    command: entry.command,
    ...(entry.args === undefined ? {} : { args: [...(entry.args as string[])] }),
    ...(entry.env === undefined ? {} : { env: { ...(entry.env as Record<string, string>) } }),
    ...(entry.cwd === undefined ? {} : { cwd: entry.cwd as string }),
  };
}

/**
 * FORK: the stdio servers in that file — `{"mcpServers": {name: {command, args?, env?, cwd?}}}`, the
 * shape of Cursor's mcp.json — or {} when it is missing, unreadable or not that shape. Entries that
 * are not stdio, are malformed, or are named t3-code are skipped. Re-read only when its mtime changes.
 */
export function localMcpServers(
  path: string = localMcpServersPath(),
): Record<string, LocalStdioMcpServer> {
  if (path === "") {
    return {};
  }
  try {
    const { mtimeMs } = NodeFS.statSync(path);
    if (localMcpServersCache?.path !== path || localMcpServersCache.mtimeMs !== mtimeMs) {
      const parsed: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
      const listed =
        typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>).mcpServers
          : undefined;
      const servers: Record<string, LocalStdioMcpServer> = {};
      if (typeof listed === "object" && listed !== null && !Array.isArray(listed)) {
        for (const [name, value] of Object.entries(listed)) {
          const server = name !== RESERVED_NAME && NAME.test(name) ? stdioServer(value) : undefined;
          if (server !== undefined) {
            servers[name] = server;
          }
        }
      }
      localMcpServersCache = { path, mtimeMs, servers };
    }
    return { ...localMcpServersCache.servers };
  } catch {
    return {};
  }
}

/** FORK: the local servers for one thread, each started in the thread's cwd unless it names its own. */
export function localMcpServersFor(
  cwd: string | null,
  path: string = localMcpServersPath(),
): Record<string, LocalStdioMcpServer> {
  const servers = localMcpServers(path);
  if (cwd === null) {
    return servers;
  }
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      server.cwd === undefined ? { ...server, cwd } : server,
    ]),
  );
}
