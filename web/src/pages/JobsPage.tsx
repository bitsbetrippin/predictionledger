/**
 * Prediction Ledger — Background Jobs tab (2.1: status chips, "?" beside the status column, loading / empty / error states).
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useEffect, useState } from "react";
import type { JobSummary } from "@prediction-ledger/shared";
import { api, content } from "../api";
import { HelpButton } from "../components/HelpButton";
import { EmptyState, ErrorState, Skeleton, StatusChip, fmtStamp } from "../components/ui";

export function JobsPage() {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => api.listJobs().then((j) => alive && setJobs(j)).catch((e: Error) => alive && setError(e.message));
    tick();
    const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <section className="page">
      <p className="muted">Durable queue: jobs survive restarts; interrupted ones resume automatically. Failed or cancelled jobs can be retried as a new run. Newest first.</p>
      {error && jobs !== null && <div className="banner error">{error}</div>}
      {error && jobs === null ? <ErrorState title="Jobs could not be loaded" message={error} /> : jobs === null ? <Skeleton rows={4} /> : jobs.length === 0 ? (
        <EmptyState title="No jobs yet.">Imports, transcription, extraction, plan generation and research all run here.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Kind</th><th>Subject</th><th>Progress</th><th>Status <HelpButton topic="troubleshoot.privacy-pending" /></th><th className="num">Attempts</th><th>Started</th><th></th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td><code>{j.kind}</code></td>
                  <td>{j.subjectType && j.subjectId ? <a href={j.subjectType === "video" ? `#/videos/${j.subjectId}` : `#/predictions?id=${j.subjectId}`}>{j.subjectType} {j.subjectId.slice(0, 8)}</a> : "—"}</td>
                  <td><span className="progress"><span className="bar" style={{ width: `${j.progress}%` }} /> {j.progress}%{j.stage ? ` · ${j.stage}` : ""}</span></td>
                  <td><StatusChip variant="filled" tone={j.status === "failed" ? "bad" : j.status === "completed" ? "ok" : j.status === "running" ? "info" : "neutral"}>{j.status}</StatusChip>{j.error ? <div className="meta" title={j.error}>{j.error.slice(0, 140)}</div> : null}</td>
                  <td className="num">{j.attempts}/{j.maxAttempts}</td>
                  <td className="small num">{fmtStamp(j.startedAt ?? j.createdAt, true)}</td>
                  <td className="row-actions">
                    {(j.status === "queued" || j.status === "running") && <button type="button" className="small" onClick={() => content.cancelJob(j.id).catch((e: Error) => setError(e.message))}>Cancel</button>}
                    {(j.status === "failed" || j.status === "cancelled") && <button type="button" className="small" onClick={() => content.retryJob(j.id).catch((e: Error) => setError(e.message))}>Retry</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
