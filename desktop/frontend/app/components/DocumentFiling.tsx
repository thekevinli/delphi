"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api, type DocumentFilingState, type Paper } from "../lib/api";
import { outdatedFiling, unfiledFiling } from "../lib/filing-progress";
import { onMemoryFiled, onMemoryQueue, requestMemoryMaintenance } from "../lib/memory-maintenance";
import { sendSessionRelease } from "../lib/session-release";
import { FilingProgress, SameDocumentCard, SettledFilingCard } from "./FilingProgress";

/**
 * The filing record for one document, and the one way to move it.
 *
 * Lifted out of `UnfiledDocument` because a second card needs exactly the
 * same things: the record, the press that queues the document's job, and
 * whether one is already queued. That card is for a document that *is*
 * filed, by a pass Delphi has since replaced or by a job that could not write
 * one of its pages, so it renders beside a rail rather than instead of one;
 * two copies of this client would have been two ideas about what "already
 * queued" means.
 *
 * The press also ends the wait on the document's session, so what the reader
 * asked and noted beside it is filed in the same run.
 */
export function useDocumentFiling({
  paper,
  projectId,
  enabled,
  onFiled,
  onNotice,
}: {
  paper: Paper | null;
  /** The document's project, which the release of its session names. */
  projectId: string | null;
  enabled: boolean;
  /** Awaited, so a caller knows whether the rail can replace its card yet. */
  onFiled: () => Promise<void>;
  onNotice: (text: string) => void;
}) {
  const [filing, setFiling] = useState(false);
  /*
   * Both of these carry the document they are about rather than being reset
   * when it changes. A card that answers "which paper is this true of" cannot
   * show the previous document's answer for a frame, and clearing them in an
   * effect would be a synchronous setState on every open — a cascading render
   * for a fact the value itself can carry.
   */
  const [record, setRecord] = useState<
    (DocumentFilingState & { paperId: string }) | null
  >(null);
  const [filedHere, setFiledHere] = useState<string | null>(null);

  const paperId = paper?.id ?? "";
  const filingRead = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++filingRead.current;
    if (!paperId || !enabled) return null;
    return api<DocumentFilingState>(
      `/api/memory/documents/${encodeURIComponent(paperId)}/filing`,
    )
      .then((answer) => {
        if (request !== filingRead.current) return null;
        setRecord({ ...answer, paperId });
        return answer;
      })
      .catch(() => null);
  }, [paperId, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => onMemoryFiled(() => void refresh()), [refresh]);

  const current = record?.paperId === paperId ? record : null;
  const queued = Boolean(current?.queued);

  /*
   * Queued work is drained by whichever tab is in front, so this card can be
   * looking at a job another surface is about to finish. Poll while there is
   * something owed and stop the moment there is not — an idle card must not
   * hold a timer for the length of a reading session.
   */
  const recheck = useCallback(() => {
    void refresh().then((answer) => {
      if (answer && !answer.queued) void onFiled();
    });
  }, [refresh, onFiled]);
  useEffect(() => {
    if (!queued || filing) return;
    const timer = window.setInterval(recheck, 15000);
    return () => window.clearInterval(timer);
  }, [queued, filing, recheck]);
  // A job that gives up is the queue's news, not a filing: unheard, the card went on saying it was queued.
  useEffect(() => (queued ? onMemoryQueue(recheck) : undefined), [queued, recheck]);

  const file = async () => {
    await api("/api/memory/backfill/papers", {
      method: "POST",
      body: JSON.stringify({ paperIds: [paperId] }),
    });
    // Asking outright ends the wait: what the reader asked and noted beside
    // this document is filed in the same run, not when they next leave it.
    if (projectId) await sendSessionRelease({ paperId, projectId });
    await refresh();
    requestMemoryMaintenance(enabled);
  };

  const start = () => {
    if (filing || !paperId) return;
    setFiling(true);
    void (async () => {
      await file();
      // Awaited, not fired off: the pages are written before the pass
      // reports done, so by the time the graph comes back the rail has
      // what it needs and this card is replaced by the neighbourhood.
      // Firing and forgetting is what left the reader looking at a
      // "not filed" panel for a document that had just been filed.
      await onFiled();
      const state = await refresh();
      if (state?.filed && !state.queued && !state.dropped.length) setFiledHere(paperId);
    })()
      .catch((error) =>
        onNotice(error instanceof Error ? error.message : "Could not file it"),
      )
      .finally(() => {
        setFiling(false);
      });
  };

  // The reader's answer about a kept page: either way the document gets its
  // page at once, and its job, let go, files the rest.
  const [answering, setAnswering] = useState(false);
  const answer = (use: boolean) => {
    if (answering || !paperId) return;
    setAnswering(true);
    void api(`/api/memory/documents/${encodeURIComponent(paperId)}/same-as`, {
      method: "POST",
      body: JSON.stringify({ use }),
    })
      .then(async () => {
        await refresh();
        requestMemoryMaintenance(enabled);
        await onFiled();
      })
      .catch((error) => {
        onNotice(error instanceof Error ? error.message : "Could not answer");
        // A 409 means the question went meanwhile; the card says what stands now.
        void refresh();
      })
      .finally(() => setAnswering(false));
  };

  return {
    record: current,
    filing,
    answering,
    answer,
    /** The document this record is about, for the progress card. */
    paper: paper ? { id: paper.id, title: paper.title } : null,
    /** This tab has just filed it, whatever the last record read said. */
    filedHere: filedHere === paperId,
    start,
    refresh,
  };
}

type FilingState = ReturnType<typeof useDocumentFiling>;

/**
 * The document has its page, and either a pass for it is in flight, its pages
 * were written by a pass Delphi has replaced, its last job could not write a
 * page, or that job gave up. A dropped page is said with the page and the
 * reason, and offers Retry.
 *
 * A sibling of the rail rather than part of it. `RelatedMemoryRail` is
 * mounted by the wiki too, where it centres on a page with no document behind
 * it, so a document-filing control inside it would be one the wiki can never
 * use. Nothing is offered until the record has answered — a card that says
 * "this is out of date" and then takes it back is worse than one that waits —
 * and no *button* is offered while a pass for it is already queued, which is
 * the only thing stopping a reader starting a second pass over a document
 * whose first one has not run yet.
 *
 * The press enqueues rather than streaming, so the card has to keep saying so
 * on its own. It used to hold a live SSE connection for the length of the
 * pass, and the queue took that away: the press returned in a second, the job
 * row made `queued` true, and the whole card unmounted — a reader pressed
 * "Update document" and got silence for the minutes the pass actually takes,
 * with nothing anywhere to say it had started. Queued is progress, not
 * absence, so it renders as progress. (Invariant 32c's sibling rule, and the
 * §8 trap that says a running pass must be the *only* thing this card says.)
 */
export function OutdatedPage({ filing }: { filing: FilingState }) {
  const record = filing.record;
  if (!record) return null;
  // Work in flight comes first, whatever the record would settle into: a first
  // filing has its page as soon as its digest is published, while the rest of
  // the pass is still to run or waiting on a retry.
  if ((filing.filing || record.queued) && filing.paper) {
    return (
      <section className="reader-unfiled is-outdated">
        <FilingProgress paper={filing.paper} title={record.filed ? "Updating this document in Memory" : undefined} />
      </section>
    );
  }
  // A page the last job could not write outranks an older pass: the reader
  // is owed that page whichever pass wrote the rest.
  const card = outdatedFiling(record);
  if (!card) return null;
  return (
    <section className="reader-unfiled is-outdated">
      <SettledFilingCard card={card} onAction={filing.start} />
    </section>
  );
}

/**
 * A document that is open but not yet drawn in the wiki's neighbourhood.
 *
 * Said outright rather than papered over with the nearest pages: the rail's
 * whole claim is "here is where *this* sits in what you know", and drawing
 * somebody else's neighbourhood under that heading would be a quiet lie.
 *
 * **"No page for this document" is not one situation, it is four**, and this
 * card used to spell all of them "not in your Knowledge yet, file it now":
 * never filed; filing already queued and waiting for the pump; filed by a pass
 * that wrote nothing carrying this document's provenance; and a filing that
 * gave up. A reader who pressed the button, came back, and was asked to press
 * it again could only conclude the press had done nothing. `GET
 * /documents/{id}/filing` is the record that separates them — two markers and
 * the job list, no model call — and each answer gets its own sentence and its
 * own verb.
 *
 * While a pass is running the card is *only* the progress: leaving the "not in
 * your Knowledge" sentence above it stacked a stale claim on top of the work
 * disproving it, which is what made the state look cluttered and confused.
 */
export function UnfiledDocument({ filing, onOpenPage }: { filing: FilingState; onOpenPage: (slug: string) => void }) {
  const current = filing.record;
  // Work in flight is the whole card: the steps while it runs, the line while
  // it waits. Pressing "File it now" enqueues, so `filing` covers the moment
  // before the queue's own record says `queued`.
  const inFlight = filing.filing || Boolean(current?.queued);
  return (
    <section className="reader-unfiled">
      <h3>Related Memory</h3>
      {current?.sameAs ? (
        <SameDocumentCard page={current.sameAs} answering={filing.answering} onAnswer={filing.answer} onOpen={onOpenPage} />
      ) : inFlight && filing.paper ? (
        <FilingProgress paper={filing.paper} />
      ) : (
        <SettledFilingCard card={unfiledFiling(current, filing.filedHere)} onAction={filing.start} />
      )}
    </section>
  );
}
