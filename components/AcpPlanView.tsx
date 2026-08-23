"use client";

import { Check, Circle, LoaderCircle } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import type { AcpPlan } from "@/lib/acp/plan";

export function AcpPlanView({ plan }: { plan: AcpPlan }) {
  const { t } = useI18n();
  const completed = plan.entries.filter((entry) => entry.status === "completed").length;
  return (
    <section className="conversation-plan" aria-label="Plan">
      <div className="conversation-plan-summary">
        <span className="conversation-plan-mark" aria-hidden="true"><PlanStatusIcon status={completed === plan.entries.length ? "completed" : "in_progress"} /></span>
        <strong>Plan</strong>
        <span className="conversation-plan-count">{completed}/{plan.entries.length}</span>
      </div>
      <div className="conversation-plan-items" data-expanded="true" aria-hidden="false">
        <div className="conversation-plan-items-inner">
          <div className="conversation-plan-items-content" role="list">
            {plan.entries.map((entry, index) => (
              <div className="conversation-plan-item" role="listitem" key={`${index}-${entry.content}`}>
                <span className="conversation-plan-status" aria-hidden="true"><PlanStatusIcon status={entry.status} /></span>
                <span className="conversation-plan-copy">
                  <span>{entry.content}</span>
                  <small>{entry.priority}</small>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {plan.entries.length === 0 ? <span className="sr-only">{t("chat.planPending")}</span> : null}
    </section>
  );
}

function PlanStatusIcon({ status }: { status: "pending" | "in_progress" | "completed" }) {
  if (status === "completed") return <Check size={13} aria-hidden="true" />;
  if (status === "in_progress") return <LoaderCircle size={13} className="conversation-plan-spinner" aria-hidden="true" />;
  return <Circle size={11} aria-hidden="true" />;
}
