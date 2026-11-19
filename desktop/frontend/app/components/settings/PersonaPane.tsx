"use client";

import { useEffect, useState } from "react";

import {
  api,
  type AppConfig,
  type Persona,
  type PersonaCatalog,
  type PersonaSummary,
} from "../../lib/api";
import { personaElement } from "../../lib/personas";
import { ElementIcon } from "../ElementIcon";
import { PersonaBackButton } from "./PersonaMarketplace";
import type { Notice } from "../Notice";

function PlusIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      className="persona-plus"
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 1.6v8.8M1.6 6h8.8" />
    </svg>
  );
}

/**
 * Managing personas: what exists, what they say, and writing your own.
 *
 * This is the picker modal's job minus the picking. Choosing which persona
 * answers is a per-conversation decision and belongs in the composer, where the
 * conversation is; what is left here is the part that was never about one chat
 * — reading the officials, writing your own, and browsing the marketplace.
 *
 * Officials and your own are sections rather than tabs. The old segmented
 * control hid the shipped rows behind a toggle, and with the marketplace no
 * longer sharing the space there is room to simply show both.
 */
export function PersonaPane({
  config,
  onNotice,
  onBrowse,
  detail,
  onDetailChange,
  reloadToken,
  onEdit,
}: {
  config: AppConfig;
  onNotice: (notice: Notice) => void;
  onBrowse: () => void;
  /** The persona whose prompt is open beside the pane, if any. */
  detail: Persona | null;
  onDetailChange: (persona: Persona | null) => void;
  /** Bumped by the sheet after a save, so the listing re-reads. */
  reloadToken: number;
  /** Open the editor on an owned persona, or on a draft forked from a body. */
  onEdit: (persona: (Partial<Persona> & { content: string }) | null) => void;
}) {
  const [catalog, setCatalog] = useState<PersonaCatalog | null>(null);

  useEffect(() => {
    let active = true;
    void api<PersonaCatalog>("/api/personas")
      .then((result) => {
        if (active) setCatalog(result);
      })
      .catch((error) => {
        if (active) {
          onNotice(
            error instanceof Error ? error.message : "Could not load personas",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [onNotice, reloadToken]);

  const inspect = async (persona: PersonaSummary) => {
    // Toggle: pressing the open persona's own button closes the panel, which is
    // the gesture a reader tries before hunting for a close control.
    if (detail?.id === persona.id) {
      onDetailChange(null);
      return;
    }
    try {
      onDetailChange(await api<Persona>(`/api/personas/${persona.id}`));
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "Could not open that persona",
      );
    }
  };

  /**
   * Open one of this reader's own personas for editing.
   *
   * Officials get no editor at all: they are code, the server refuses a PATCH
   * with a 409, and a "start from this" button beside each one was a second way
   * to do what "New persona" already does. Reading one opens its detail;
   * writing one starts blank.
   */
  const openEditor = async (persona: PersonaSummary) => {
    try {
      onEdit(await api<Persona>(`/api/personas/${persona.id}`));
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "Could not open that persona",
      );
    }
  };

  const rows = (personas: PersonaSummary[]) => (
    <div className="persona-settings-list">
      {personas.map((persona) => (
        <div key={persona.id} className={`persona-settings-row${detail?.id === persona.id ? " active" : ""}`}>
          <button type="button" className="persona-settings-open"
            aria-label={`See ${persona.name} in detail`}
            aria-expanded={detail?.id === persona.id}
            onClick={() => void inspect(persona)}>
            <span className={`persona-icon-tile element-${personaElement(persona.element)}`}>
              <ElementIcon element={personaElement(persona.element)} size={16} />
            </span>
            <span className="persona-settings-copy">
              <strong>{persona.name}</strong>
              {persona.tagline ? <span>{persona.tagline}</span> : null}
            </span>
            <svg className="persona-row-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
          </button>
          {!persona.official ? <button type="button" className="secondary-button persona-settings-edit" onClick={() => void openEditor(persona)}>Edit</button> : null}
        </div>
      ))}
    </div>
  );

  return (
    <div className="persona-settings-content">
      <header className="persona-settings-heading"><h3>Persona</h3>
        <p>How Delphi reads with you: choose its focus and voice depending on the context.</p>
      </header>
      {catalog === null ? <p className="persona-empty" role="status">Loading…</p> : <>
        <section className="persona-settings-group" aria-labelledby="persona-official-heading">
          <div className="persona-group-bar"><h4 id="persona-official-heading">Official</h4></div>
          {rows(catalog.official)}
        </section>
        <section className="persona-settings-group" aria-labelledby="persona-yours-heading">
          <div className="persona-group-bar"><h4 id="persona-yours-heading">Yours</h4>
            <button type="button" className="primary-button persona-create" onClick={() => onEdit(null)}><PlusIcon size={13} /><span>New persona</span></button>
          </div>
          {catalog.mine.length ? rows(catalog.mine) : <div className="persona-settings-empty">
            <strong>No personas yet</strong>
            <p>{config.personaMarketplaceEnabled ? <>Write your own, or copy one from the <button type="button" onClick={onBrowse}>marketplace</button>.</> : "Write your own to give Delphi a different focus and voice."}</p>
          </div>}
          {config.personaMarketplaceEnabled && catalog.mine.length > 0 ? <button type="button" className="persona-market-entry" onClick={onBrowse}>Persona Marketplace</button> : null}
        </section>
      </>}
    </div>
  );
}

/** The system prompt, in the column the sheet widens to make room for. */
export function PersonaDetail({
  persona,
  onClose,
}: {
  persona: Persona;
  onClose: () => void;
}) {
  return (
    <aside className="settings-detail" aria-label={`${persona.name} instructions`}>
      <div className="settings-detail-head">
        {/* The marketplace's own Back: collapsing this column is returning to
            the list, not closing the sheet, and a chevron beside the sheet's
            close read as a second X. */}
        <PersonaBackButton onClick={onClose} />
        <h4>
          <ElementIcon element={personaElement(persona.element)} size={17} />
          <span>{persona.name}</span>
        </h4>
      </div>
      {/* Plain text: a persona body is instructions, and rendering it as
          markdown would let a published one lay out this reader's sheet. */}
      <pre>{persona.content}</pre>
    </aside>
  );
}
