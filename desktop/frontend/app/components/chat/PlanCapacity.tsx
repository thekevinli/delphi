"use client";
import { useEffect, useRef, useState, type MouseEvent } from "react";

type Plan = { id: string; title: string; revision: number };
type Capacity = { plans: Plan[]; limit: number; pending: number };

/** The suspended send owns its prompt; only explicit checklist confirmation
 * changes storage. Closing the panel or leaving the conversation cancels it. */
export function usePlanCapacity(scope: string) {
  const [state, setState] = useState<Capacity | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<((proceed: boolean) => void) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const finish = (proceed: boolean) => {
    const resolve = pending.current; pending.current = null;
    setState(null); setSelected([]); setError(""); setBusy(false);
    resolve?.(proceed);
  };
  useEffect(() => () => { pending.current?.(false); pending.current = null; }, [scope]);
  useEffect(() => { if (state && !dialog.current?.open) dialog.current?.showModal(); }, [state]);
  const check = async (resolve: (proceed: boolean) => void) => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/desktop/plans/capacity", { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("Could not check plan storage. Try again.");
      const current: Capacity = await response.json();
      if (pending.current !== resolve) return;
      if (current.plans.length + current.pending < current.limit) finish(true);
      else { setState(current); setSelected([]); setBusy(false); }
    } catch (e) { if (pending.current === resolve) { setState(current => current ?? { plans: [], limit: 3, pending: 0 }); setError(e instanceof Error ? e.message : "Could not check storage."); setBusy(false); } }
  };
  // Whether this panel can still show the dialog. A panel remounted under a
  // new key — creating a conversation does that — cannot, and a check begun
  // on it would wait forever for an answer nobody can give.
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  /** Resolves true once there is room; false when the reader cancels, the
   * send is stopped (`signal`), or this panel can no longer ask. */
  const ensure = (signal?: AbortSignal) => {
    if (!mounted.current || pending.current || signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      pending.current = resolve;
      setState(null);
      signal?.addEventListener("abort", () => { if (pending.current === resolve) finish(false); }, { once: true });
      void check(resolve);
    });
  };
  const archive = async () => {
    const resolve = pending.current;
    if (!state || !resolve || !selected.length || busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/desktop/plans/archive", { method: "POST", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/json" }, body: JSON.stringify({ selected: state.plans.filter(p => selected.includes(p.id)).map(({id, revision}) => ({id, revision})) }) });
      const result = await response.json();
      if (pending.current !== resolve) return;
      if (!response.ok) {
        if (result.plans) { setState(result); setSelected([]); }
        throw new Error(result.error || "Could not archive plans. Try again.");
      }
      await check(resolve);
    } catch (e) { if (pending.current === resolve) { setError(e instanceof Error ? e.message : "Could not archive plans."); setBusy(false); } }
  };
  /* Dismissing by clicking away needs both halves, and neither alone is right.
   * A modal dialog's backdrop reports the dialog as its target, but so does a
   * click on the dialog's own padding — so the usual target test cancels the
   * panel from inside it. Bounds alone are no better: activating a checkbox
   * from the keyboard fires a click carrying no coordinates, and (0, 0) reads
   * as outside every box. Ask for both: the dialog itself, and a pointer that
   * really is beyond its edges. */
  const backdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (busy || event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) finish(false);
  };
  const panel = state ? <dialog ref={dialog} className="modal plan-capacity-modal" aria-labelledby="plan-capacity-title" onCancel={e => { e.preventDefault(); if (!busy) finish(false); }} onClick={backdrop}>
    <span className="eyebrow">Plan storage</span>
    <h2 id="plan-capacity-title">Make room for your plan</h2>
    <p>Delphi keeps {state.limit} plans. Choose which to archive — your request continues afterwards, and archived records are kept.</p>
    <div className="plan-capacity-list">
      {state.plans.map(plan => <label key={plan.id} className="plan-capacity-row" data-selected={selected.includes(plan.id) || undefined} title={plan.id}>
        <input type="checkbox" checked={selected.includes(plan.id)} disabled={busy} onChange={e => setSelected(ids => e.target.checked ? [...ids, plan.id] : ids.filter(id => id !== plan.id))} />
        <span><strong>{plan.title}</strong><small>{plan.id.slice(0, 8)} · rev {plan.revision}</small></span>
      </label>)}
    </div>
    {state.pending > 0 ? <p className="plan-capacity-note">Another plan is being drafted. You can wait and check again.</p> : null}
    {busy ? <p className="plan-capacity-note" role="status">Checking plan storage…</p> : null}
    {error ? <p className="modal-error" role="alert">{error}</p> : null}
    <div className="modal-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={() => finish(false)}>Cancel</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { if (pending.current) void check(pending.current); }}>Check again</button>
      <button type="button" className="primary-button" disabled={busy || !selected.length} onClick={() => void archive()}>{selected.length ? `Archive ${selected.length} and continue` : "Archive and continue"}</button>
    </div>
  </dialog> : null;
  return { ensure, panel, waiting: busy || state !== null };
}
