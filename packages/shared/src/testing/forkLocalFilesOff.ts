// FORK: no package test reads the developer's own ~/.config/t3code/instructions.md or
// mcp-servers.json; tests that need one set a path. The server's own setup does the same.
process.env.T3CODE_LOCAL_INSTRUCTIONS_FILE ??= "";
process.env.T3CODE_LOCAL_MCP_SERVERS_FILE ??= "";
