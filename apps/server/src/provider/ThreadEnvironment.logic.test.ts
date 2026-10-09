// FORK: which T3 thread and project a provider process belongs to, for the hooks it runs.
import { describe, expect, it } from "vite-plus/test";

import {
  codexThreadEnvironmentConfig,
  threadEnvironment,
  withThreadEnvironment,
  withThreadEnvironmentInMcpServers,
} from "./ThreadEnvironment.logic.ts";

const input = { threadId: "thread:t1", projectRoot: "/projects/aihub" };

describe("threadEnvironment", () => {
  it("names the thread and the project's root checkout", () => {
    expect(threadEnvironment(input)).toEqual({
      T3CODE_THREAD_ID: "thread:t1",
      T3CODE_PROJECT_ROOT: "/projects/aihub",
    });
  });

  it("leaves out a project root it does not know", () => {
    expect(threadEnvironment({ threadId: "thread:t1" })).toEqual({ T3CODE_THREAD_ID: "thread:t1" });
    expect(threadEnvironment({ threadId: "thread:t1", projectRoot: null })).toEqual({
      T3CODE_THREAD_ID: "thread:t1",
    });
    expect(threadEnvironment({ threadId: "thread:t1", projectRoot: "  " })).toEqual({
      T3CODE_THREAD_ID: "thread:t1",
    });
  });
});

describe("withThreadEnvironment", () => {
  it("adds the variables and keeps every other one, FORK-006 and FORK-008 included", () => {
    const base = {
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/home/mp/.claude",
      T3CODE_LOCAL_INSTRUCTIONS_FILE: "/home/mp/.config/t3code/instructions.md",
      T3CODE_LOCAL_MCP_SERVERS_FILE: "/home/mp/.config/t3code/mcp-servers.json",
    };
    expect(withThreadEnvironment(base, input)).toEqual({
      ...base,
      T3CODE_THREAD_ID: "thread:t1",
      T3CODE_PROJECT_ROOT: "/projects/aihub",
    });
  });

  it("overrides values the server inherited, and does not change its argument", () => {
    const base = { T3CODE_THREAD_ID: "thread:inherited", T3CODE_PROJECT_ROOT: "/inherited" };
    expect(withThreadEnvironment(base, input)).toEqual({
      T3CODE_THREAD_ID: "thread:t1",
      T3CODE_PROJECT_ROOT: "/projects/aihub",
    });
    expect(base).toEqual({
      T3CODE_THREAD_ID: "thread:inherited",
      T3CODE_PROJECT_ROOT: "/inherited",
    });
  });

  it("drops an inherited project root rather than let a hook read another project's path", () => {
    expect(
      withThreadEnvironment(
        { T3CODE_PROJECT_ROOT: "/inherited", PATH: "/usr/bin" },
        {
          threadId: "thread:t1",
        },
      ),
    ).toEqual({ PATH: "/usr/bin", T3CODE_THREAD_ID: "thread:t1" });
  });
});

describe("codexThreadEnvironmentConfig", () => {
  it("sets each variable as a leaf of the thread's shell environment policy", () => {
    expect(codexThreadEnvironmentConfig(input)).toEqual({
      "shell_environment_policy.set.T3CODE_THREAD_ID": "thread:t1",
      "shell_environment_policy.set.T3CODE_PROJECT_ROOT": "/projects/aihub",
    });
    expect(codexThreadEnvironmentConfig({ threadId: "thread:t1" })).toEqual({
      "shell_environment_policy.set.T3CODE_THREAD_ID": "thread:t1",
    });
  });
});

describe("withThreadEnvironmentInMcpServers", () => {
  it("adds the variables to each server and keeps the server's own", () => {
    const servers = {
      plain: { type: "stdio" as const, command: "a" },
      own: { type: "stdio" as const, command: "b", env: { TOKEN: "x", T3CODE_THREAD_ID: "mine" } },
    };
    expect(withThreadEnvironmentInMcpServers(servers, input)).toEqual({
      plain: {
        type: "stdio",
        command: "a",
        env: { T3CODE_THREAD_ID: "thread:t1", T3CODE_PROJECT_ROOT: "/projects/aihub" },
      },
      own: {
        type: "stdio",
        command: "b",
        env: {
          TOKEN: "x",
          T3CODE_THREAD_ID: "thread:t1",
          T3CODE_PROJECT_ROOT: "/projects/aihub",
        },
      },
    });
    expect(servers.own.env).toEqual({ TOKEN: "x", T3CODE_THREAD_ID: "mine" });
  });
});
