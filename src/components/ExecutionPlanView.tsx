import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { ExecutionPlan, PlanMode } from "../api";
import { t, tf } from "../i18n";
import { readExecutionPlan, type PlanNode } from "../sqlPlan";
import { ResultEmpty } from "./DataGrid";

const numeric = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });

function NodeRow({ node, expandable }: { node: PlanNode; expandable: boolean }) {
  return <span className="plan-node-row">
    <ChevronRight className={expandable ? "plan-chevron" : "plan-leaf"} size={13} aria-hidden="true" />
    <span className="plan-node-label">
      <strong>{node.name}</strong>
      {node.target && <code>{node.target}</code>}
    </span>
    <span className="plan-metrics">
      {node.estimatedRows !== undefined && <span>{tf("Estimated {value}", { value: numeric.format(node.estimatedRows) })}</span>}
      {node.actualRows !== undefined && <span>{tf("Actual {value}", { value: numeric.format(node.actualRows) })}</span>}
      {node.loops !== undefined && <span>{tf("Loops {value}", { value: numeric.format(node.loops) })}</span>}
      {node.timeMs !== undefined && <span>{numeric.format(node.timeMs)} ms</span>}
    </span>
  </span>;
}

function Nodes({ nodes, level = 0 }: { nodes: PlanNode[]; level?: number }) {
  return <ul className="plan-nodes">
    {nodes.map((node, index) => <li key={index}>
      {node.children.length || node.details.length ? (
        <details open={node.children.length > 0 && level < 2}>
          <summary><NodeRow node={node} expandable /></summary>
          {node.details.length > 0 && <dl className="plan-node-details">
            {node.details.map(([label, value], i) => <div key={i}>
              {label && <dt>{label}</dt>}
              <dd>{value}</dd>
            </div>)}
          </dl>}
          {node.children.length > 0 && <Nodes nodes={node.children} level={level + 1} />}
        </details>
      ) : <NodeRow node={node} expandable={false} />}
    </li>)}
  </ul>;
}

export function ExecutionPlanView({ plan, mode }: { plan: ExecutionPlan; mode: PlanMode }) {
  const { nodes, raw, planningMs, executionMs } = useMemo(() => readExecutionPlan(plan), [plan]);
  const [showRaw, setShowRaw] = useState(false);
  const rawOnly = !nodes.length;
  return <div className="plan-view">
    <div className="toolbar plan-toolbar">
      <strong>{mode === "analyze" ? "EXPLAIN ANALYZE" : "EXPLAIN"}</strong>
      {planningMs !== undefined && <span className="muted">{tf("Planning {value} ms", { value: numeric.format(planningMs) })}</span>}
      {executionMs !== undefined && <span className="muted">{tf("Execution {value} ms", { value: numeric.format(executionMs) })}</span>}
      {plan.result.truncated && <span className="muted">{t("Plan output truncated")}</span>}
      {!rawOnly && <button type="button" aria-pressed={showRaw} onClick={() => setShowRaw(!showRaw)}>{t("Raw output")}</button>}
    </div>
    {showRaw || rawOnly ? raw ? <pre className="plan-raw">{raw}</pre> : <ResultEmpty title={t("No plan nodes returned")} />
      : <Nodes nodes={nodes} />}
  </div>;
}
