"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type MemoryPage, type MemoryPageDeletion } from "../lib/api";
import { DomainChip, DomainMenu, domainMenuAt, type DomainMenuAt } from "./DomainPicker";
import { ModalLayer } from "./ModalLayer";

const NOTHING_ELSE: MemoryPageDeletion = { domain: null, left: null, destinations: [] };

/**
 * Delete one concept page, or a source page whose document is gone.
 *
 * When the delete takes the page's domain too, the dialog says so: the page
 * was the domain's last, or a domain a model named would keep one page, which
 * moves to the domain it sits closest to or one the reader picks
 * (`GET /api/memory/pages/{slug}/deletion`). A pick made on a domain that has
 * changed since is refused, and the dialog reads it again. With the read
 * failed, nothing is shown and the server folds the page as it would.
 */
export function DeletePageModal({ page, onClose, onDelete }: {
  page: MemoryPage;
  onClose: () => void;
  /** `moves` is what the reader picked; `landing` the domain the map opens at afterwards. */
  onDelete: (moves: Record<string, string>, landing: string | null) => Promise<void>;
}) {
  const [plan, setPlan] = useState<MemoryPageDeletion | null>(null);
  const [choice, setChoice] = useState("");
  const [menu, setMenu] = useState<DomainMenuAt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = (next: MemoryPageDeletion, changed: boolean) => {
    setPlan(next);
    setChoice((current) => {
      const kept = changed && next.destinations.some((domain) => domain.slug === current) ? current : "";
      return next.left ? kept || next.left.suggested : "";
    });
    setError(changed ? "This domain changed. Look again." : null);
  };
  const read = () => api<MemoryPageDeletion>(`/api/memory/pages/${encodeURIComponent(page.slug)}/deletion`);

  useEffect(() => {
    let active = true;
    read().then((next) => { if (active) adopt(next, false); }).catch(() => { if (active) setPlan(NOTHING_ELSE); });
    return () => { active = false; };
    // Read once per page; a refusal reads it again itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.slug]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (menu) setMenu(null);
      else if (!busy) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menu, busy, onClose]);

  const confirm = async () => {
    if (!plan || busy) return;
    setBusy(true);
    setError(null);
    try {
      const moves = plan.left && choice ? { [plan.left.slug]: choice } : {};
      await onDelete(moves, plan.domain ? (plan.left ? choice : null) : page.domain);
      onClose();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        await read().then((next) => adopt(next, true), () => setError("Could not read this page's domain"));
      } else {
        setError(failure instanceof Error ? failure.message : "Could not delete the page");
      }
      setBusy(false);
    }
  };

  const titleOf = (domain: string) => plan?.destinations.find((item) => item.slug === domain)?.title ?? domain;

  return (
    <ModalLayer>
      <div className="modal-backdrop" onMouseDown={() => (menu ? setMenu(null) : busy ? undefined : onClose())}>
        <div
          className="modal is-quiet delete-modal"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="delete-page-title"
          aria-describedby="delete-page-description"
          onMouseDown={(event) => {
            event.stopPropagation();
            if (menu) setMenu(null);
          }}
        >
          <div className="delete-modal-heading">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="modal-warning-icon" src="/brand/animations/delphi-warning-alert.gif" alt="" />
            <h2 id="delete-page-title">Delete page?</h2>
          </div>
          <p className="modal-subject" title={page.title}>{page.title}</p>
          <p id="delete-page-description">This can’t be undone.</p>
          {plan?.domain ? (
            <div className="delete-modal-memory">
              <span className="eyebrow">Also in Memory</span>
              <ul className="delete-domain-box delete-page-effects">
                <li>
                  <span className="kb-memory-dot kb-memory-dot-domain" aria-hidden="true" />
                  <span className="delete-domain-title" title={plan.domain.title}>{plan.domain.title}</span>
                  <span className="delete-page-effect is-gone">Deleted</span>
                </li>
                {plan.left ? (
                  <li>
                    <span className={`kb-memory-dot kb-memory-dot-${plan.left.kind}`} aria-hidden="true" />
                    <span className="delete-domain-title" title={plan.left.title}>{plan.left.title}</span>
                    <span className="delete-page-effect">Moves to</span>
                    <DomainChip
                      value={choice}
                      title={titleOf(choice)}
                      open={menu !== null}
                      label={`Move ${plan.left.title} to`}
                      onClick={(event) => setMenu(menu ? null : domainMenuAt("left", event, plan.destinations.length))}
                    />
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
          {error ? <p className="modal-error">{error}</p> : null}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
            {/* Waits for the read: pressed sooner, the domain would go unannounced. */}
            <button type="button" className="danger-button" disabled={!plan || busy} onClick={() => void confirm()}>
              Delete page
            </button>
          </div>
        </div>
      </div>
      {menu && plan ? (
        <DomainMenu
          at={menu}
          destinations={plan.destinations}
          current={choice}
          onPick={(domain) => {
            setChoice(domain);
            setMenu(null);
          }}
        />
      ) : null}
    </ModalLayer>
  );
}
