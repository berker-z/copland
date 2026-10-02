/* ============================================================================
   What an AI assistant or tool is called, for people.
   ----------------------------------------------------------------------------
   Shared by the Worker (a task's history: "berker via Claude Code") and the
   settings list of tokens and connected apps.
   ========================================================================== */

/**
 * How MCP clients introduce themselves ("claude-code", "codex-mcp-client")
 * is for machines; the history says it the way people do. Unknown names pass
 * through as they came.
 */
const KNOWN_CLIENTS: Array<[RegExp, string]> = [
  [/claude[-_ ]?code/i, "Claude Code"],
  [/claude/i, "Claude"],
  [/codex/i, "Codex"],
  [/cursor/i, "Cursor"],
  [/windsurf|codeium/i, "Windsurf"],
  [/copilot|vscode/i, "VS Code"],
  [/gemini/i, "Gemini"],
  [/chatgpt|openai/i, "ChatGPT"],
];

export function clientLabel(raw: string): string {
  return KNOWN_CLIENTS.find(([pattern]) => pattern.test(raw))?.[1] ?? raw;
}
