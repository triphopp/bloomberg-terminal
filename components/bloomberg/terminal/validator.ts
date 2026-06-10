import { AstNode, ParseResult } from "./types";
import { CMD_MAP, FUNC_NAMES } from "./registry";

/**
 * Validate a parsed AST against the registry.
 * Returns { ok: true, ast } or { ok: false, error }.
 */
export function validate(result: ParseResult): ParseResult {
  if (!result.ok) return result;

  const { ast } = result;

  if (ast.kind === "call") {
    const def = CMD_MAP.get(ast.fn);
    if (!def) {
      return {
        ok:    false,
        error: `Unknown function: ${ast.fn}().  Type HELP to see all commands.`,
      };
    }

    const required = (def.args ?? []).filter((a) => !a.optional).length;
    // For variadic commands (symbols...) args length is unbounded
    const isVariadic = def.args?.some((a) => a.name.includes("..."));

    if (!isVariadic) {
      const max = def.args?.length ?? 0;
      if (ast.args.length < required) {
        const usage = def.args
          ?.map((a) => (a.optional ? `${a.name}?` : a.name))
          .join(", ");
        return {
          ok:    false,
          error: `${def.name} needs at least ${required} arg(s). Usage: ${def.name}(${usage})`,
        };
      }
      if (ast.args.length > max) {
        return {
          ok:    false,
          error: `${def.name} takes at most ${max} arg(s), got ${ast.args.length}`,
        };
      }
    }
  }

  if (ast.kind === "set") {
    if (!CMD_MAP.has(ast.cmd)) {
      return {
        ok:    false,
        error: `Unknown command: ${ast.cmd}.  Type HELP to see all commands.`,
      };
    }
  }

  return result;
}
