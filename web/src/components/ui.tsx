/**
 * Prediction Ledger — small presentational primitives shared by every page (2.1 UI refresh): status chips (filled =
 * evidence assessment, outlined = time status — always both, never merged), tags, tiles, tabs, empty / error / loading states.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import type { ReactNode } from "react";
import { EVIDENCE_ASSESSMENT_LABEL, TIME_STATUS_LABEL, type EvidenceAssessment, type TimeStatusValue } from "@prediction-ledger/shared";
import { Icon, type IconName } from "./Icons";

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

export const ASSESSMENT_TONE: Record<EvidenceAssessment, Tone> = { supported: "ok", partially_supported: "warn", contradicted: "bad", insufficient: "neutral", not_assessable: "neutral" };
export const TIME_TONE: Record<TimeStatusValue, Tone> = { pending: "info", reached: "neutral", unknown: "neutral" };

/** Sports picks read as bets settle: hit / miss / push — the same underlying two-field verdict. */
export const SPORTS_RESULT_LABEL: Partial<Record<EvidenceAssessment, string>> = { supported: "Hit", contradicted: "Miss", partially_supported: "Push", insufficient: "No final score yet", not_assessable: "Not settleable" };

export function StatusChip({ tone = "neutral", variant, children, title }: { tone?: Tone; variant: "filled" | "outlined"; children: ReactNode; title?: string }) {
  return <span className={`status ${variant} tone-${tone}`} title={title}>{children}</span>;
}

/** Evidence assessment: a filled chip. */
export function AssessmentChip({ value, sports }: { value: EvidenceAssessment; sports?: boolean }) {
  const label = sports ? SPORTS_RESULT_LABEL[value] ?? EVIDENCE_ASSESSMENT_LABEL[value] : EVIDENCE_ASSESSMENT_LABEL[value];
  return <StatusChip variant="filled" tone={ASSESSMENT_TONE[value]} title={`Evidence assessment: ${EVIDENCE_ASSESSMENT_LABEL[value]}`}>{label}</StatusChip>;
}

/** Time status: an outlined chip. */
export function TimeChip({ value }: { value: TimeStatusValue }) {
  return <StatusChip variant="outlined" tone={TIME_TONE[value]} title="Time status (computed by the app from the deadline)">{TIME_STATUS_LABEL[value]}</StatusChip>;
}

export function Tag({ kind, children }: { kind: "money" | "paper" | "action" | "informational"; children?: ReactNode }) {
  const text = children ?? (kind === "money" ? "Real money" : kind === "paper" ? "Paper" : kind === "action" ? "Action required" : "Informational");
  return <span className={`tag ${kind}`}>{text}</span>;
}

export const KIND_LABEL: Record<string, string> = { future_claim: "future claim", premise: "premise", causal_link: "causal link" };
export function KindChip({ kind }: { kind: string }) {
  return <span className={`chip kind kind-${kind}`}>{KIND_LABEL[kind] ?? kind}</span>;
}

export function Tile({ label, value, meta, tone, help, className }: { label: ReactNode; value: ReactNode; meta?: ReactNode; tone?: Tone; help?: ReactNode; className?: string }) {
  return (
    <div className={`tile${tone ? ` tone-${tone}` : ""}${className ? ` ${className}` : ""}`}>
      <span className="label"><span>{label}</span>{help}</span>
      <strong>{value}</strong>
      {meta !== undefined && <span className="meta">{meta}</span>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items, ariaLabel }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode }[]; ariaLabel?: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((it) => (
        <button key={it.id} type="button" role="tab" aria-selected={value === it.id} className={value === it.id ? "tab active" : "tab"} onClick={() => onChange(it.id)}>{it.label}</button>
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state" role="status">
      <p><strong style={{ fontWeight: 500 }}>{title}</strong></p>
      {children && <p className="muted">{children}</p>}
      {action && <div className="row" style={{ justifyContent: "center", marginTop: 10 }}>{action}</div>}
    </div>
  );
}

export function ErrorState({ title = "Something went wrong", message, onRetry, children }: { title?: ReactNode; message?: ReactNode; onRetry?: () => void; children?: ReactNode }) {
  return (
    <div className="error-state" role="alert">
      <div className="row"><Icon name="warningCircle" size={16} /><strong>{title}</strong></div>
      {message && <p className="small" style={{ margin: "6px 0 0" }}>{message}</p>}
      {children}
      {onRetry && <div className="row" style={{ marginTop: 8 }}><button type="button" onClick={onRetry}>Try again</button></div>}
    </div>
  );
}

/** Skeleton rows for a table or list; shown after the 150 ms grace the handoff asks for. */
export function Skeleton({ rows = 4, widths = ["60%", "40%", "75%", "50%"] }: { rows?: number; widths?: string[] }) {
  return (
    <div aria-busy="true" aria-live="polite" className="skeleton-block" style={{ padding: "6px 0" }}>
      {Array.from({ length: rows }).map((_, i) => <span key={i} className="skeleton line" style={{ width: widths[i % widths.length] }} />)}
    </div>
  );
}

export function InlineIcon({ name, size = 14, className }: { name: IconName; size?: number; className?: string }) {
  return <Icon name={name} size={size} className={className} style={{ verticalAlign: "-2px" }} />;
}

/** `YYYY-MM-DD HH:MM` from an ISO string (UTC as stored). */
export const fmtStamp = (iso?: string, seconds = false) => (iso ? iso.slice(0, seconds ? 19 : 16).replace("T", " ") : "—");
