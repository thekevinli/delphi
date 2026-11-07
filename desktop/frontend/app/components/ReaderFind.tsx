"use client";

import { useEffect, useRef, useState } from "react";
import type { FindResult } from "../lib/document-find";

export function ReaderFind({ search, resetKey }: {
  search: (query: string, index: number) => Promise<FindResult>;
  resetKey: string | number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<FindResult>({ total: 0, index: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const serial = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const searchRef = useRef(search);
  searchRef.current = search;
  const run = async (text: string, index: number) => {
    const id = ++serial.current;
    setBusy(Boolean(text)); setError("");
    try {
      // Closing changes `open` and cleans up the debounced query effect.
      // That invalidates old results, but must never skip clearing highlights.
      const task = queue.current.catch(() => {}).then(() => id === serial.current || !text.trim() ? searchRef.current(text, index) : null);
      queue.current = task;
      const next = await task;
      if (id === serial.current && next) setResult(next);
    } catch {
      if (id === serial.current) { setResult({ total: 0, index: 0 }); setError("Search unavailable"); }
    } finally { if (id === serial.current) setBusy(false); }
  };
  const close = () => { setOpen(false); setQuery(""); void run("", 0); };
  useEffect(() => {
    const show = () => { setOpen(true); requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); }); };
    const clear = () => { serial.current++; queue.current = queue.current.catch(() => {}).then(() => searchRef.current("", 0)).catch(() => {}); };
    const dismiss = () => { setOpen(false); setQuery(""); clear(); };
    window.addEventListener("delphi-reader-find", show);
    window.addEventListener("delphi-reader-find-close", dismiss);
    return () => { window.removeEventListener("delphi-reader-find", show); window.removeEventListener("delphi-reader-find-close", dismiss); clear(); };
  }, []);
  useEffect(() => { setQuery(""); setResult({ total: 0, index: 0 }); serial.current++; }, [resetKey]);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => { void run(query, 0); }, 120);
    return () => { clearTimeout(timer); serial.current++; };
  }, [query, open, resetKey]);
  if (!open) return null;
  return (
    <div className="reader-find" role="search" aria-label="Find in document" onClick={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === "Enter") { event.preventDefault(); if (query && !busy) void run(query, result.index + (event.shiftKey ? -1 : 1)); }
    }}>
      <input ref={input} autoFocus aria-label="Find in document" placeholder="Find in document" maxLength={500} value={query} onChange={event => setQuery(event.target.value)} />
      <span className="reader-find-count" role="status" aria-live="polite">{error || (busy ? "…" : `${result.total ? result.index + 1 : 0}/${result.total}`)}</span>
      <button className="icon-button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!result.total || busy} onClick={() => void run(query, result.index - 1)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
      </button>
      <button className="icon-button" aria-label="Next match" title="Next match (Enter)" disabled={!result.total || busy} onClick={() => void run(query, result.index + 1)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" /></svg>
      </button>
      <button className="icon-button" aria-label="Close find" title="Close (Esc)" onClick={close}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </div>
  );
}
