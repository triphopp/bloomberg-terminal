import { AstNode, CommandResult, ResolvedArgs, TerminalCtx } from "./types";
import { CMD_MAP } from "./registry";

/**
 * Execute a validated AST node.
 * signal: AbortSignal for cancelling in-flight fetch requests.
 */
export async function executeAst(
  ast:    AstNode,
  ctx:    TerminalCtx,
  signal: AbortSignal,
): Promise<CommandResult> {
  try {
    if (ast.kind === "call") {
      const def = CMD_MAP.get(ast.fn);
      if (!def) return { kind: "error", message: `Unknown function: ${ast.fn}` };
      const resolved: ResolvedArgs = { positional: ast.args };
      return await def.handler(resolved, ctx, signal);
    }

    if (ast.kind === "nav" || ast.kind === "set") {
      const def = CMD_MAP.get(ast.cmd);
      if (!def) return { kind: "error", message: `Unknown command: ${ast.cmd}` };
      const resolved: ResolvedArgs = { positional: [] };
      return await def.handler(resolved, ctx, signal);
    }

    if (ast.kind === "lookup") {
      // bare symbol → navigate to stock analysis
      ctx.setStockSymbol(ast.symbol);
      ctx.setView("stock");
      return { kind: "navigate", view: "stock" };
    }

    return { kind: "error", message: "Unrecognised AST node" };
  } catch (e) {
    if (signal.aborted) {
      // DOMException name "AbortError" — not an application error
      return { kind: "error", message: "Cancelled" };
    }
    return { kind: "error", message: (e as Error).message ?? "Unexpected error" };
  }
}
