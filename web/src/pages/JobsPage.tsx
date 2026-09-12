/**
 * Prediction Ledger — Background Jobs tab.
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useEffect, useState } from "react";
import type { JobSummary } from "@prediction-ledger/shared";
import { api, content } from "../api";

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
      <h1>Background Jobs</h1>
      <p className="muted">Durable queue: jobs survive restarts; interrupted ones resume automatically. Failed or cancelled jobs can be retried as a new run. Newest first.</p>
      {error && <div className="banner error">{error}</div>}
      {jobs === null ? <p className="muted">Loading…</p> : jobs.length === 0 ? (
        <div className="empty-state"><p className="muted">No jobs yet. Extraction and plan generation will appear here.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Kind</th><th>Subject</th><th>Progress</th><th>Status</th><th>Attempts</th><th>Started</th><th></th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td><code>{j.kind}</code></td>
                  <td>{j.subjectType && j.subjectId ? <a href={j.subjectType === "video" ? `#/videos/${j.subjectId}` : `#/predictions?id=${j.subjectId}`}>{j.subjectType} {j.subjectId.slice(0, 8)}</a> : "—"}</td>
                  <td><span className="progress"><span className="bar" style={{ width: `${j.progress}%` }} /> {j.progress}%{j.stage ? ` · ${j.stage}` : ""}</span></td>
                  <td className={j.status === "failed" ? "result error" : j.status === "completed" ? "result ok" : ""}>{j.status}{j.error ? <div className="small" title={j.error}>{j.error.slice(0, 140)}</div> : null}</td>
                  <td>{j.attempts}/{j.maxAttempts}</td>
                  <td className="small">{(j.startedAt ?? j.createdAt).slice(0, 19).replace("T", " ")}</td>
                  <td className="row-actions">
                    {(j.status === "queued" || j.status === "running") && <button type="button" onClick={() => content.cancelJob(j.id).catch((e: Error) => setError(e.message))}>Cancel</button>}
                    {(j.status === "failed" || j.status === "cancelled") && <button type="button" onClick={() => content.retryJob(j.id).catch((e: Error) => setError(e.message))}>Retry</button>}
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
