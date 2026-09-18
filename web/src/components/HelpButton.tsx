/**
 * Prediction Ledger — the contextual "?" (2.1): a small button that opens a positioned popover with the topic's
 * What this means → What the app is doing → What you can do next, and a "Read more" that opens the Learn panel.
 * Click / tap and keyboard (Enter / Space open, Esc closes, focus returns to the button). Never hover-only.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { findTopic, type HelpTopic } from "../help/topics";
import { Icon } from "./Icons";
import { useLearn } from "./LearnPanel";
import { ESC_PRIORITY, useEscape } from "./escape";

export function HelpButton({ topic, label, children, className }: { topic: string; label?: string; children?: ReactNode; className?: string }) {
  const t = findTopic(topic);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  if (!t) return null;
  const close = (restore = true) => { setOpen(false); if (restore) btnRef.current?.focus(); };
  const inline = children !== undefined;
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={className ?? (inline ? "help-link" : "help-btn")}
        aria-label={label ?? `Help: ${t.title}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={inline ? undefined : t.title}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      >
        <Icon name="question" size={inline ? 13 : 12} />{inline ? <span>{children}</span> : null}
      </button>
      {open && <HelpPopover id={id} topic={t} anchor={btnRef.current} onClose={close} />}
    </>
  );
}

export function HelpPopover({ id, topic, anchor, onClose }: { id: string; topic: HelpTopic; anchor: HTMLElement | null; onClose: (restore?: boolean) => void }) {
  const learn = useLearn();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useLayoutEffect(() => {
    const place = () => {
      const r = anchor?.getBoundingClientRect();
      const w = Math.min(340, window.innerWidth - 24);
      const h = ref.current?.offsetHeight ?? 200;
      if (!r) return setPos({ top: 12, left: 12 });
      let left = Math.min(Math.max(12, r.left - 8), window.innerWidth - w - 12);
      let top = r.bottom + 8;
      if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 8);
      setPos({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  useEffect(() => { ref.current?.focus(); }, []);
  const closeWithFocus = useCallback(() => onClose(), [onClose]);
  useEscape(ESC_PRIORITY.popover, true, closeWithFocus);

  return (
    <>
      <div className="help-backdrop" onClick={() => onClose(false)} aria-hidden="true" />
      <div id={id} ref={ref} className="help-popover" role="dialog" aria-label={topic.title} tabIndex={-1} style={{ top: pos.top, left: pos.left }} onClick={(e) => e.stopPropagation()}>
        <h5>{topic.title}</h5>
        <h6>What this means</h6>
        <p>{topic.what}</p>
        <h6>What the app is doing</h6>
        <p>{topic.doing}</p>
        <h6>What you can do next</h6>
        <p>{topic.next}</p>
        <div className="foot">
          <button type="button" className="help-link" onClick={() => { onClose(false); learn.open(topic.id); }}><Icon name="bookOpenText" size={13} />Read more</button>
          <button type="button" className="link" onClick={() => onClose()}>Close (Esc)</button>
        </div>
      </div>
    </>
  );
}
