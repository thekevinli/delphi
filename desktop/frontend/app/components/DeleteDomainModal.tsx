"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, ApiError, type MemoryDomainDeleted, type MemoryDomainDeletion } from "../lib/api";
import { DomainChip, DomainMenu, domainMenuAt, type DomainMenuAt } from "./DomainPicker";
import { ModalLayer } from "./ModalLayer";

/**
 * Delete a domain with what is in it, in at most two steps.
 *
 * A document's page outlives its domain, so step one asks where each goes,
 * suggesting the domain it sits closest to. Every other page goes with the
 * domain, so step two lists them, and the pages that stay but will lose a link
 * to one. A step with nothing to show is skipped: a domain of document pages
 * alone is deleted from step one, a domain of concept pages alone opens on step
 * two, and an empty domain is one confirmation.
 *
 * What it shows is the server's (`GET /api/memory/domains/{slug}/deletion`),
 * and the delete sends back the pages it showed, so a page filed while it was
 * open is refused rather than deleted unseen; the dialog reads the domain
 * again and says so.
 */
export function DeleteDomainModal({
  slug,
  title,
  onClose,
  onDeleted,
}: {
  slug: string;
  title: string;
  onClose: () => void;
  onDeleted: (result: MemoryDomainDeleted) => void;
}) {
  const [plan, setPlan] = useState<MemoryDomainDeletion | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [step, setStep] = useState<1 | 2>(1);
  const [menu, setMenu] = useState<DomainMenuAt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const one = useRef<HTMLElement>(null);
  const two = useRef<HTMLElement>(null);

  /** What the server says the delete would do, with the choices made so far kept where they still apply. */
  const adopt = (next: MemoryDomainDeletion, changed: boolean) => {
    setPlan(next);
    // A choice already made stands; a page that arrived since starts at its suggestion.
    setChoices((current) => Object.fromEntries(next.sources.flatMap((source) => {
      const chosen = current[source.slug] ?? source.suggested;
      return chosen && next.destinations.some((domain) => domain.slug === chosen) ? [[source.slug, chosen]] : [];
    })));
    setStep(1);
    setError(changed ? "Something was filed here while this was open. Look again." : null);
  };
  const read = () => api<MemoryDomainDeletion>(`/api/memory/domains/${encodeURIComponent(slug)}/deletion`);
  const failed = (failure: unknown) => setError(failure instanceof Error ? failure.message : "Could not read this domain");

  useEffect(() => {
    let active = true;
    read().then((next) => { if (active) adopt(next, false); }).catch((failure) => { if (active) failed(failure); });
    return () => { active = false; };
    // Read once per domain; a refusal reads it again itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const sources = plan?.sources ?? [];
  const hasSources = sources.length > 0;
  const hasDelete = (plan?.pages.length ?? 0) > 0;
  const hasInactive = (plan?.unlinked.length ?? 0) > 0;
  const needStepTwo = hasDelete || hasInactive;
  const twoSteps = hasSources && needStepTwo;
  const showingTwo = needStepTwo && (!hasSources || step === 2);
  const allChosen = sources.every((source) => choices[source.slug]);
  const values = sources.map((source) => choices[source.slug] ?? "");
  const shared = values.length > 0 && values.every((value) => value && value === values[0]) ? values[0] : "";
  const titleOf = (domain: string) => plan?.destinations.find((item) => item.slug === domain)?.title ?? domain;

  // The steps slide inside a window as tall as the one showing.
  useLayoutEffect(() => {
    const shown = showingTwo ? two.current : one.current;
    if (shown) setHeight(shown.offsetHeight);
  }, [plan, showingTwo, choices, error]);

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

  const openMenu = (id: string) => (event: React.MouseEvent<HTMLButtonElement>) => {
    if (menu?.id === id) {
      setMenu(null);
      return;
    }
    setMenu(domainMenuAt(id, event, plan?.destinations.length ?? 0));
  };

  const pick = (domain: string) => {
    if (!menu) return;
    setChoices((current) => ({
      ...current,
      ...Object.fromEntries(sources.filter((source) => menu.id === "all" || source.slug === menu.id)
        .map((source) => [source.slug, domain])),
    }));
    setMenu(null);
  };

  const confirm = async () => {
    if (!plan || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<MemoryDomainDeleted>(`/api/memory/domains/${encodeURIComponent(slug)}`, {
        method: "DELETE",
        body: JSON.stringify({ members: plan.members, moves: choices }),
      });
      onDeleted(result);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) await read().then((next) => adopt(next, true), failed);
      else setError(failure instanceof Error ? failure.message : "Could not delete this domain");
      setBusy(false);
    }
  };

  const deleteCount = plan?.pages.length ?? 0;
  const deleteLabel = deleteCount ? `Delete domain and ${deleteCount} page${deleteCount === 1 ? "" : "s"}` : "Delete domain";
  const chip = (id: string, value: string, label: string) => (
    <DomainChip value={value} title={titleOf(value)} open={menu?.id === id} label={label} onClick={openMenu(id)} />
  );

  return (
    <ModalLayer>
      <div className="modal-backdrop" onMouseDown={() => (menu ? setMenu(null) : busy ? undefined : onClose())}>
        <div
          className="modal is-quiet delete-modal delete-domain-modal"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="delete-domain-title"
          onMouseDown={(event) => {
            event.stopPropagation();
            if (menu) setMenu(null);
          }}
        >
          <div className="delete-modal-heading">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="modal-warning-icon" src="/brand/animations/delphi-warning-alert.gif" alt="" />
            <h2 id="delete-domain-title">Delete domain?</h2>
            {twoSteps ? <span className="eyebrow delete-domain-count">Step {showingTwo ? 2 : 1} of 2</span> : null}
          </div>
          <p className="modal-subject" title={plan?.domain.title ?? title}>{plan?.domain.title ?? title}</p>

          {plan && (hasSources || needStepTwo) ? (
            <div className="delete-domain-window" style={height ? { height } : undefined}>
              <div className={showingTwo ? "delete-domain-track is-second" : "delete-domain-track"}>
                <section
                  ref={one}
                  aria-label="Move the source pages"
                  aria-hidden={showingTwo}
                  inert={showingTwo}
                >
                  <p>Deleting this domain would leave the following source pages stranded.</p>
                  <div className="delete-domain-box delete-domain-sources">
                    <div className="delete-domain-box-heading">
                      <span className="eyebrow">Source pages · {sources.length}</span>
                      <button
                        type="button"
                        className="delete-domain-move-all eyebrow"
                        aria-haspopup="listbox"
                        aria-expanded={menu?.id === "all"}
                        aria-label="Move every source page to"
                        onClick={openMenu("all")}
                      >
                        Move all
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                      </button>
                    </div>
                    <ul onScroll={() => setMenu(null)}>
                      {sources.map((source) => (
                        <li key={source.slug}>
                          <span className="kb-memory-dot kb-memory-dot-source" aria-hidden="true" />
                          <span className="delete-domain-title" title={source.title}>{source.title}</span>
                          <span className="delete-domain-chip-slot">
                            {chip(source.slug, choices[source.slug] ?? "", `Move ${source.title} to`)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {error && !showingTwo ? <p className="modal-error">{error}</p> : null}
                  <div className="modal-actions">
                    <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
                    {needStepTwo ? (
                      <button type="button" className="primary-button" disabled={!allChosen} onClick={() => {
                        setMenu(null);
                        setStep(2);
                      }}>Next</button>
                    ) : (
                      <button type="button" className="danger-button" disabled={!allChosen || busy} onClick={() => void confirm()}>
                        Delete domain
                      </button>
                    )}
                  </div>
                </section>

                <section
                  ref={two}
                  aria-label="Review what is deleted"
                  aria-hidden={!showingTwo}
                  inert={!showingTwo}
                >
                  <p>
                    {hasDelete ? <strong>Deleting the domain would also remove ALL the concept pages in it.</strong> : null}
                    {hasInactive ? " Pages that referenced these pages will have inactive links hereafter." : null}
                    {" "}This cannot be undone.
                  </p>
                  <div className={hasDelete && hasInactive ? "delete-domain-lists is-pair" : "delete-domain-lists"}>
                    {hasDelete ? (
                      <section className="delete-domain-box" aria-labelledby="delete-domain-doomed">
                        <h3 id="delete-domain-doomed" className="eyebrow"><span>Pages to delete</span><span>{deleteCount}</span></h3>
                        <ul>
                          {plan.pages.map((page) => (
                            <li key={page.slug}>
                              <span className={`kb-memory-dot kb-memory-dot-${page.kind}`} aria-hidden="true" />
                              <span className="delete-domain-title" title={page.title}>{page.title}</span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                    {hasInactive ? (
                      <section className="delete-domain-box" aria-labelledby="delete-domain-unlinked">
                        <h3 id="delete-domain-unlinked" className="eyebrow">
                          <span>Pages with inactive links</span><span>{plan.unlinked.length}</span>
                        </h3>
                        <ul>
                          {plan.unlinked.map((page) => (
                            <li key={page.slug}>
                              <span className={`kb-memory-dot kb-memory-dot-${page.kind}`} aria-hidden="true" />
                              <span className="delete-domain-title" title={page.title}>{page.title}</span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                  </div>
                  {error && showingTwo ? <p className="modal-error">{error}</p> : null}
                  <div className="modal-actions">
                    {hasInactive ? (
                      <span className="delete-domain-legend" aria-hidden="true">
                        <span><i className="kb-memory-dot kb-memory-dot-domain" />Domain</span>
                        <span><i className="kb-memory-dot kb-memory-dot-source" />Source</span>
                        <span><i className="kb-memory-dot kb-memory-dot-concept" />Concept</span>
                      </span>
                    ) : null}
                    {twoSteps ? (
                      <button type="button" className="secondary-button" disabled={busy} onClick={() => setStep(1)}>Back</button>
                    ) : (
                      <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
                    )}
                    <button type="button" className="danger-button" disabled={busy} onClick={() => void confirm()}>
                      {deleteLabel}
                    </button>
                  </div>
                </section>
              </div>
            </div>
          ) : (
            <>
              {error ? <p className="modal-error">{error}</p> : null}
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
                <button type="button" className="danger-button" disabled={!plan || busy} onClick={() => void confirm()}>
                  Delete domain
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {menu && plan ? (
        <DomainMenu
          at={menu}
          destinations={plan.destinations}
          current={menu.id === "all" ? shared : choices[menu.id] ?? ""}
          onPick={pick}
        />
      ) : null}
    </ModalLayer>
  );
}
