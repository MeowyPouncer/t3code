// FORK: which T3 thread and project a provider process belongs to, for the hooks it runs.

/** FORK: the T3 thread id (`thread:…`) the provider process works for. */
export const T3_THREAD_ID_ENV = "T3CODE_THREAD_ID";

/** FORK: the project's root checkout, not the thread's worktree (same name as T3's terminals and project scripts use). */
export const T3_PROJECT_ROOT_ENV = "T3CODE_PROJECT_ROOT";

export interface ThreadEnvironmentInput {
  readonly threadId: string;
  /** The project's `workspaceRoot`; absent when the caller could not resolve the project. */
  readonly projectRoot?: string | null | undefined;
}

/**
 * FORK: the two variables, without any that are unknown. An empty project root is unknown, so a hook
 * never reads a blank path.
 */
export function threadEnvironment(input: ThreadEnvironmentInput): Record<string, string> {
  const projectRoot = input.projectRoot ?? "";
  return {
    [T3_THREAD_ID_ENV]: input.threadId,
    ...(projectRoot.trim() === "" ? {} : { [T3_PROJECT_ROOT_ENV]: projectRoot }),
  };
}

/**
 * FORK: a provider process's environment with this thread's variables on top. They win over an
 * inherited value of the same name (a T3 server started from a T3 terminal inherits that terminal's
 * `T3CODE_PROJECT_ROOT`), and an unknown project root drops such an inherited value rather than let a
 * hook read another project's path. Every other variable, `T3CODE_LOCAL_*` included, passes through.
 */
export function withThreadEnvironment(
  base: NodeJS.ProcessEnv,
  input: ThreadEnvironmentInput,
): NodeJS.ProcessEnv {
  const { [T3_PROJECT_ROOT_ENV]: _inheritedRoot, ...rest } = base;
  return { ...rest, ...threadEnvironment(input) };
}

/**
 * FORK: Codex's per-thread config overrides (`thread/start`, `thread/resume`, `thread/fork`) that set
 * the variables for every command the thread's shell tool runs. One shared app-server serves all
 * threads and its hooks inherit that server's own environment, so a Codex hook cannot see them.
 */
export function codexThreadEnvironmentConfig(
  input: ThreadEnvironmentInput,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(threadEnvironment(input)).map(([name, value]) => [
      `shell_environment_policy.set.${name}`,
      value,
    ]),
  );
}

/**
 * FORK: stdio MCP servers (`McpServerConfig`, the shape Cursor's SDK takes) with this thread's
 * variables in their `env`. A server's own `env` is kept; the thread's values win for these two names.
 */
export function withThreadEnvironmentInMcpServers<
  Server extends { readonly env?: Record<string, string> },
>(
  servers: Readonly<Record<string, Server>>,
  input: ThreadEnvironmentInput,
): Record<string, Server> {
  const variables = threadEnvironment(input);
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      { ...server, env: { ...server.env, ...variables } },
    ]),
  );
}
