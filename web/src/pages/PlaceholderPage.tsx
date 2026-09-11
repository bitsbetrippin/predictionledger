/**
 * Prediction Ledger — placeholder for tabs that land in later releases.
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
export function PlaceholderPage(props: { title: string; release: string; body: string }) {
  return (
    <section className="page">
      <h1>{props.title}</h1>
      <div className="empty-state">
        <p className="muted">Arrives in Release {props.release}</p>
        <p>{props.body}</p>
        <p className="muted">
          See <code>docs/BUILD_PLAN.md</code> for the release plan.
        </p>
      </div>
    </section>
  );
}
