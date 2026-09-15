"use client";

/**
 * The scanner's complaint about one rule, shown in the rule lists.
 *
 * A rule that cannot be evaluated is otherwise indistinguishable from a rule
 * that simply hasn't fired — both show an empty ticker. That gap is what let
 * the whole scanner sit dead for three weeks with only a log line to show for
 * it (memory/sessions/reports/alert-scan-dead-since-2026-08-25-risk-report.md).
 * The rule the user can see is the one they can fix.
 */

import { AlertTriangle } from "lucide-react";
import type { AlertRule } from "../hooks/useAlertRules";

export function RuleErrorMark({ rule }: { rule: Pick<AlertRule, "enabled" | "lastError"> }) {
  if (!rule.lastError) return null;
  // enabled=false next to an error means the scanner switched it off, which is
  // worth saying outright — the user did not do it.
  const title = rule.enabled
    ? `Last scan skipped this rule: ${rule.lastError}`
    : `Disabled by the scanner: ${rule.lastError}`;
  return (
    <span title={title} className="shrink-0 leading-none">
      <AlertTriangle className="h-2.5 w-2.5" style={{ color: "#fbbf24" }} aria-label={title} />
    </span>
  );
}
