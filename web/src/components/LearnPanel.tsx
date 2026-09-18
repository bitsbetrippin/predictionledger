/**
 * Prediction Ledger — the Learn panel (2.1): a 380 px right-hand panel (full-screen below 880 px) with search, group
 * chips, the "On this screen" list and an article view. Opening it is UI state only: filters, selections and unsaved
 * edits on the page underneath survive. The same TOPICS feed the inline "?" popovers and the Learn & Reference page.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GROUPS, findTopic, searchTopics, sourceUrl, type HelpGroup, type HelpTopic } from "../help/topics";
import { screenTopics, type ScreenName } from "../help/context";
import { Icon } from "./Icons";
import { ESC_PRIORITY, useEscape } from "./escape";

export interface LearnApi {
  /** Open the panel, optionally on a topic. */
  open: (topicId?: string) => void;
  close: () => void;
  isOpen: boolean;
  topicId?: string;
}

const LearnContext = createContext<LearnApi>({ open: () => undefined, close: () => undefined, isOpen: false });

export function useLearn(): LearnApi {
  return useContext(LearnContext);
}

export function LearnProvider({ screen, children }: { screen: ScreenName; children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [topicId, setTopicId] = useState<string | undefined>(undefined);
  const open = useCallback((id?: string) => { setTopicId(id); setOpen(true); }, []);
  const close = useCallback(() => setOpen(false), []);
  const api = useMemo(() => ({ open, close, isOpen, topicId }), [open, close, isOpen, topicId]);
  return (
    <LearnContext.Provider value={api}>
      {children}
      {isOpen && <LearnPanel screen={screen} topicId={topicId} onSelect={setTopicId} onClose={close} />}
    </LearnContext.Provider>
  );
}

export function LearnPanel({ screen, topicId, onSelect, onClose }: { screen: ScreenName; topicId?: string; onSelect: (id: string | undefined) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<HelpGroup | "">("");
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    if (!topicId) searchRef.current?.focus(); else panelRef.current?.focus();
    return () => { restoreFocus.current?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEscape(ESC_PRIORITY.learn, true, onClose);

  const topic = topicId ? findTopic(topicId) : undefined;
  const onScreen = screenTopics(screen);
  const results = useMemo(() => {
    const base = searchTopics(q);
    return group ? base.filter((t) => t.group === group) : base;
  }, [q, group]);

  return (
    <aside className="learn-panel" role="dialog" aria-label="Learn and reference" ref={panelRef} tabIndex={-1}>
      <div className="head">
        {topic ? (
          <button type="button" className="icon-btn" aria-label="Back to the topic list" onClick={() => onSelect(undefined)}><Icon name="caretLeft" /></button>
        ) : (
          <Icon name="magnifyingGlass" size={14} className="muted" />
        )}
        {!topic && <input ref={searchRef} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search guides, terms, holds, alerts…" aria-label="Search the reference" />}
        {topic && <strong style={{ flex: 1, fontWeight: 500 }}>{GROUPS.find((g) => g.id === topic.group)?.label}</strong>}
        <a className="icon-btn" href="#/learn" title="Open Learn & Reference" aria-label="Open the Learn & Reference page" onClick={onClose}><Icon name="bookOpenText" /></a>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
      </div>
      <div className="body">
        {topic ? (
          <Article topic={topic} onSelect={onSelect} />
        ) : (
          <>
            <div className="group-chips" role="group" aria-label="Filter by group">
              <button type="button" className={`group-chip${group === "" ? " active" : ""}`} onClick={() => setGroup("")}>All</button>
              {GROUPS.map((g) => <button key={g.id} type="button" className={`group-chip${group === g.id ? " active" : ""}`} onClick={() => setGroup(group === g.id ? "" : g.id)}>{g.label}</button>)}
            </div>
            {!q && !group && onScreen.length > 0 && (
              <>
                <h4>On this screen</h4>
                <TopicList topics={onScreen} onSelect={onSelect} />
              </>
            )}
            <h4>{q || group ? `${results.length} topic${results.length === 1 ? "" : "s"}` : "All topics"}</h4>
            {results.length === 0 ? <p className="muted">Nothing matches. Try a hold name (discrepancy), an alert kind, or a term such as “deadline”.</p> : <TopicList topics={results} onSelect={onSelect} grouped={!q && !group} />}
          </>
        )}
      </div>
    </aside>
  );
}

function TopicList({ topics, onSelect, grouped, activeId }: { topics: HelpTopic[]; onSelect: (id: string) => void; grouped?: boolean; activeId?: string }) {
  if (!grouped) {
    return (
      <ul className="topic-list">
        {topics.map((t) => <li key={t.id}><button type="button" className={t.id === activeId ? "active" : undefined} onClick={() => onSelect(t.id)}>{t.title}<span className="meta">{t.what.length > 96 ? `${t.what.slice(0, 96)}…` : t.what}</span></button></li>)}
      </ul>
    );
  }
  return (
    <>
      {GROUPS.map((g) => {
        const list = topics.filter((t) => t.group === g.id);
        if (!list.length) return null;
        return (
          <div key={g.id}>
            <div className="learn-nav-group">{g.label}</div>
            <ul className="topic-list">{list.map((t) => <li key={t.id}><button type="button" className={t.id === activeId ? "active" : undefined} onClick={() => onSelect(t.id)}>{t.title}</button></li>)}</ul>
          </div>
        );
      })}
    </>
  );
}

/** One topic rendered in full: What this means → What the app is doing → What you can do next → body → related → source. */
export function Article({ topic, onSelect, showExampleLink = true }: { topic: HelpTopic; onSelect: (id: string) => void; showExampleLink?: boolean }) {
  return (
    <article className="article">
      <h2>{topic.title}</h2>
      <p className="meta">{topic.id}</p>
      <h6>What this means</h6>
      <p>{topic.what}</p>
      <h6>What the app is doing</h6>
      <p>{topic.doing}</p>
      <h6>What you can do next</h6>
      <p>{topic.next}</p>
      {topic.body.length > 0 && (
        <>
          <h6>More</h6>
          {topic.body.map((b, i) => <p key={i}>{b}</p>)}
        </>
      )}
      {topic.id === "example.worked" && showExampleLink && <p><a href="#/learn?topic=example.worked">Open the interactive worked example →</a></p>}
      {topic.related.length > 0 && (
        <>
          <h6>Related</h6>
          <p className="related">{topic.related.map((id) => { const r = findTopic(id); return r ? <button key={id} type="button" className="link" onClick={() => onSelect(id)}>{r.title}</button> : null; })}</p>
        </>
      )}
      <h6>Source</h6>
      <p className="small"><code>{topic.source}</code> · <a href={sourceUrl(topic)} target="_blank" rel="noreferrer noopener">repository copy <Icon name="arrowSquareOut" size={11} /></a></p>
    </article>
  );
}
