/**
 * Prediction Ledger — Learn & Reference page (2.1): every topic by group, the article view, and the interactive worked
 * example (six synthetic, labelled steps from docs/WORKED_EXAMPLE.md). Nothing on this page calls the API or writes a record.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useEffect, useMemo, useState } from "react";
import { GROUPS, TOPICS, findTopic, searchTopics } from "../help/topics";
import { WORKED_EXAMPLE, type WorkedExampleStep } from "../help/workedExample";
import { Article } from "../components/LearnPanel";
import { Icon } from "../components/Icons";
import { KindChip, StatusChip, Tabs } from "../components/ui";
import { navigate } from "../App";

const EXAMPLE = "example.worked";

export function LearnPage({ topicId }: { topicId?: string }) {
  const [q, setQ] = useState("");
  const selected = topicId ? findTopic(topicId) : undefined;
  const showExample = topicId === EXAMPLE;
  const results = useMemo(() => searchTopics(q).filter((t) => t.id !== EXAMPLE), [q]);
  const select = (id?: string) => navigate(id ? `/learn?topic=${encodeURIComponent(id)}` : "/learn");

  return (
    <section className="page wide">
      <div className={`learn-layout${topicId ? " article-open" : ""}`}>
        <div className="side">
          <div className="row" style={{ marginBottom: 8 }}>
            <Icon name="magnifyingGlass" size={14} className="muted" />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search guides, terms, holds, alerts…" aria-label="Search the reference" style={{ flex: 1 }} />
          </div>
          <a className={`example-card${showExample ? " active" : ""}`} href={`#/learn?topic=${EXAMPLE}`}>
            <span className="row tight"><Icon name="flask" size={14} /><strong>Interactive worked example</strong></span>
            <span className="meta">A claim → plan → evidence → assessment · synthetic</span>
          </a>
          {GROUPS.filter((g) => g.id !== "example").map((g) => {
            const list = results.filter((t) => t.group === g.id);
            if (!list.length) return null;
            return (
              <div key={g.id}>
                <div className="learn-nav-group">{g.label}</div>
                <ul className="topic-list">{list.map((t) => <li key={t.id}><a href={`#/learn?topic=${encodeURIComponent(t.id)}`} className={topicId === t.id ? "active" : undefined}>{t.title}</a></li>)}</ul>
              </div>
            );
          })}
          {results.length === 0 && <p className="muted">Nothing matches “{q}”.</p>}
        </div>
        <div>
          {showExample ? (
            <WorkedExample />
          ) : selected ? (
            <>
              <p className="small"><a href="#/learn" onClick={(e) => { e.preventDefault(); select(); }}>← All topics</a></p>
              <Article topic={selected} onSelect={(id) => select(id)} showExampleLink />
            </>
          ) : (
            <Overview />
          )}
        </div>
      </div>
    </section>
  );
}

function Overview() {
  return (
    <div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>How to read this app</h2>
        <p className="muted">The ledger is a courtroom, not a pundit. Extraction is the clerk, the validation plan is the judge's instructions written before testimony, research is discovery, assessment is the verdict. Every number on every page comes from a stored, inspectable record — and every screen has a <span className="help-btn" aria-hidden="true" style={{ verticalAlign: "-4px" }}><Icon name="question" size={12} /></span> beside the term it uses.</p>
        <p className="muted">Press <span className="kbd">/</span> anywhere to search this reference. The text ships with the app; the repository copy is the secondary link on each topic.</p>
      </div>
      <div className="grid-3">
        {GROUPS.map((g) => (
          <div key={g.id} className="card">
            <h3 style={{ marginTop: 0 }}>{g.label}</h3>
            <ul className="plain small">{TOPICS.filter((t) => t.group === g.id).slice(0, 6).map((t) => <li key={t.id}><a href={`#/learn?topic=${encodeURIComponent(t.id)}`}>{t.title}</a></li>)}</ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The six-step stepper. Synthetic throughout; the banner says so and nothing here touches the API. */
function WorkedExample() {
  const steps = WORKED_EXAMPLE.steps;
  const [i, setI] = useState(0);
  const step = steps[i];
  useEffect(() => { document.querySelector(".content")?.scrollTo({ top: 0 }); }, [i]);
  return (
    <div>
      <div className="synthetic" role="note">
        <Icon name="flask" />
        <div><strong style={{ fontWeight: 500 }}>Synthetic demonstration.</strong> Transcript, pages, search results and model outputs are labelled fixtures from <code>fixtures/</code>. No real citation, no real-world outcome, and none of it is written to your records.</div>
      </div>
      <h4 style={{ marginTop: 0 }}>Worked example</h4>
      <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>{WORKED_EXAMPLE.title}</h2>
      <p className="meta">{WORKED_EXAMPLE.fixture} · <code>{WORKED_EXAMPLE.source}</code></p>
      <div className="stepper" role="tablist" aria-label="Worked example steps">
        {steps.map((s, n) => <button key={s.id} type="button" role="tab" aria-selected={n === i} className={n === i ? "active" : undefined} onClick={() => setI(n)}><span className="n">{n + 1}</span>{s.label}</button>)}
      </div>
      <div className="why"><Icon name="info" /><span>{step.why}</span></div>
      <StepBody step={step} />
      <div className="row space-between" style={{ marginTop: 16 }}>
        <button type="button" disabled={i === 0} onClick={() => setI(i - 1)}><Icon name="caretLeft" size={12} /> Previous</button>
        <span className="meta">Step {i + 1} of {steps.length}</span>
        <button type="button" className="primary" disabled={i === steps.length - 1} onClick={() => setI(i + 1)}>Next <Icon name="caretRight" size={12} /></button>
      </div>
    </div>
  );
}

function StepBody({ step }: { step: WorkedExampleStep }) {
  const [planTab, setPlanTab] = useState<"criteria" | "queries">("criteria");
  switch (step.id) {
    case "statement":
      return (
        <div>
          <div className="quote"><div className="meta">{step.stamp}</div><mark>“{step.quote}”</mark></div>
          {step.notes?.map((n, k) => <p key={k} className="muted small">{n}</p>)}
        </div>
      );
    case "extraction":
      return (
        <div>
          <dl className="facts">
            {step.facts?.map(([k, v, who]) => <FactRow key={k} k={k} v={v} who={who} />)}
          </dl>
          <h4>Components</h4>
          <ul className="components">{step.components?.map((c, k) => <li key={k}><KindChip kind={c[0].replace(" ", "_")} /> {c[1]}</li>)}</ul>
        </div>
      );
    case "plan": {
      const p = step.plan!;
      return (
        <div>
          <p><strong style={{ fontWeight: 500 }}>Proposition.</strong> {p.proposition}</p>
          <p className="muted small"><strong style={{ fontWeight: 500 }}>Working definition.</strong> {p.definition}</p>
          <Tabs value={planTab} onChange={setPlanTab} items={[{ id: "criteria", label: "Criteria" }, { id: "queries", label: "Search queries" }]} />
          {planTab === "criteria" ? (
            <div className="grid-3">
              <div><h4>Would support</h4><ul className="plain small">{p.support.map((s, k) => <li key={k}>{s}</li>)}</ul></div>
              <div><h4>Would contradict</h4><ul className="plain small">{p.contradict.map((s, k) => <li key={k}>{s}</li>)}</ul></div>
              <div><h4>Partial fulfilment</h4><ul className="plain small">{p.partial.map((s, k) => <li key={k}>{s}</li>)}</ul></div>
            </div>
          ) : (
            <div className="grid-3">
              {(["neutral", "supporting", "disconfirming"] as const).map((k) => <div key={k}><h4>{k}</h4><ul className="plain small">{p.queries[k].map((s, n) => <li key={n}><code>{s}</code></li>)}</ul></div>)}
            </div>
          )}
        </div>
      );
    }
    case "research":
      return (
        <div>
          {step.sources?.map((s, k) => (
            <div key={k} className={`evidence-card${s.syndicated ? " excluded" : ""}`}>
              <div className="row space-between small">
                <span><span className={`chip stance-${s.stance}`}>{s.stance}</span> <KindChip kind={s.component.replace(" ", "_")} /> {s.stage && <span className="chip">{s.stage}</span>} {s.syndicated && <span className="chip" title="Same content hash as another source">syndicated</span>}</span>
                <span className="meta">{s.date}</span>
              </div>
              <div><strong style={{ fontWeight: 500 }}>{s.title}</strong> <span className="meta">· {s.pub}</span></div>
              <div className="small">{s.kept}</div>
              <div className="meta">{s.note}</div>
            </div>
          ))}
        </div>
      );
    case "assessment":
      return (
        <div>
          <div className="banner warn"><strong style={{ fontWeight: 500 }}>What the model said:</strong> {step.modelSaid}</div>
          <h4>Rules applied by the app</h4>
          <table className="checklist-table"><tbody>{step.rules?.map(([id, text]) => <tr key={id}><td><code>{id}</code></td><td>{text}</td></tr>)}</tbody></table>
          <h4>Component assessments</h4>
          <ul className="plain">{(step.components as [string, string, string][] | undefined)?.map(([kind, verdict, why], k) => <li key={k}><KindChip kind={kind.replace(" ", "_")} /> <StatusChip variant="filled" tone={verdict.startsWith("Supported") ? "ok" : verdict.startsWith("Partially") ? "warn" : "neutral"}>{verdict}</StatusChip> <span className="muted">{why}</span></li>)}</ul>
        </div>
      );
    case "row": {
      const r = step.row!;
      return (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Prediction</th><th>Deadline</th><th>Result</th><th>Time status</th><th>Brief explanation</th><th>Sources</th><th>Last checked</th></tr></thead>
            <tbody>
              <tr>
                <td>{r.prediction}</td>
                <td className="num">{r.deadline}</td>
                <td><StatusChip variant="filled" tone="warn">{r.result}</StatusChip><div className="meta">confidence {r.confidence}</div></td>
                <td><StatusChip variant="outlined" tone="info">{r.time}</StatusChip></td>
                <td className="explain">{r.explanation}</td>
                <td className="num">{r.sources}</td>
                <td className="num small">{r.checked}</td>
              </tr>
            </tbody>
          </table>
        </div>
      );
    }
    default:
      return null;
  }
}

function FactRow({ k, v, who }: { k: string; v: string; who: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v} <span className="meta">({who})</span></dd>
    </>
  );
}
