import { resolveSymbol } from "../lib/resolve-symbol";
import { CMD_MAP } from "./registry";
import type { AstNode, CommandResult, ResolvedArgs, TerminalCtx } from "./types";

/**
 * Execute a validated AST node.
 * signal: AbortSignal for cancelling in-flight fetch requests.
 */
export async function executeAst(
  ast: AstNode,
  ctx: TerminalCtx,
  signal: AbortSignal
): Promise<CommandResult> {
  try {
    if (ast.kind === "call") {
      const def = CMD_MAP.get(ast.fn);
      if (!def) return { kind: "error", message: `Unknown function: ${ast.fn}` };
      // Typed tickers → Yahoo symbols (CPALL → CPALL.BK). Only analysis
      // functions take tickers — HEATMAP(TH, high) takes a market code and a
      // metric, which must never turn into TH.BK / HIGH.BK.
      const positional =
        def.group === "analysis"
          ? await Promise.all(
              ast.args.map((a) =>
                a.type === "symbol"
                  ? resolveSymbol(a.value, signal).then((value) => ({ ...a, value }))
                  : a
              )
            )
          : ast.args;
      if (signal.aborted) return { kind: "error", message: "Cancelled" };
      const resolved: ResolvedArgs = { positional };
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
      ctx.setStockSymbol(await resolveSymbol(ast.symbol, signal));
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
