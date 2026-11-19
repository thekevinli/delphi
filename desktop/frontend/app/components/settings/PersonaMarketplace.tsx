"use client";

import { useEffect, useState } from "react";

import {
  api,
  type Persona,
  type PersonaBrowsePage,
  type PersonaSummary,
} from "../../lib/api";
import { personaElement } from "../../lib/personas";
import { ElementIcon } from "../ElementIcon";
import { hint, type Notice } from "../Notice";

/**
 * Back, not close: the sheet is still open behind the current pane and the
 * reader came from somewhere they can return to. Closing here would drop them
 * on the page and make this feel like a place they left.
 *
 * Shared with the system-prompt column, which collapses the same way — the
 * chevron-only control there read as a second close beside the sheet's own.
 */
export function PersonaBackButton({
  onClick,
  children = "Back",
}: {
  onClick: () => void;
  children?: string;
}) {
  return (
    <button type="button" className="persona-market-back" onClick={onClick}>
      <span aria-hidden="true">‹</span> {children}
    </button>
  );
}

/**
 * Personas other people published.
 *
 * A shelf, not the picker again. The picker is a short list of things you
 * switch between; this is a browse over strangers' work, and it shows the two
 * facts only a published persona has — who wrote it and how many people took a
 * copy. Hence a grid rather than rows, and the element colour carried as a band
 * rather than as one icon in a column: at a glance the cards are distinct
 * objects instead of a list that happens to be longer.
 *
 * Nothing is ever applied unseen. A card opens the full body first, and only
 * then offers to install — which forks it into a persona this account owns. It
 * is that fork, not a permission check, that makes running a stranger's
 * instructions safe.
 */
export function PersonaMarketplace({
  onBack,
  onInstalled,
  onNotice,
}: {
  onBack: () => void;
  onInstalled: () => Promise<void>;
  onNotice: (notice: Notice) => void;
}) {
  const [rows, setRows] = useState<PersonaSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<Persona | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (next: string | null, search: string, append: boolean) => {
    setBusy(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("q", search.trim());
      if (next) params.set("cursor", next);
      const page = await api<PersonaBrowsePage>(
        `/api/personas/browse?${params.toString()}`,
      );
      setRows((current) => (append ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "Could not reach the marketplace",
      );
    } finally {
      setBusy(false);
    }
  };

  // Debounced, so typing a search is one request per pause rather than one per
  // keystroke — the same shape the account-wide search box uses.
  useEffect(() => {
    const timer = setTimeout(() => void load(null, query, false), 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const install = async (persona: Persona) => {
    setBusy(true);
    try {
      await api(`/api/personas/${persona.id}/install`, { method: "POST" });
      setPreview(null);
      await onInstalled();
      onNotice(hint(`${persona.name} is now one of your personas`));
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "Could not install that persona",
      );
    } finally {
      setBusy(false);
    }
  };

  const open = async (persona: PersonaSummary) => {
    try {
      setPreview(await api<Persona>(`/api/personas/${persona.id}`));
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "Could not open that persona",
      );
    }
  };

  if (preview) {
    return (
      <div className="persona-market">
        <PersonaBody
          persona={preview}
          busy={busy}
          onBack={() => setPreview(null)}
          onInstall={() => void install(preview)}
        />
      </div>
    );
  }

  return (
    <div className="persona-market">
      <div className="persona-market-head">
        <PersonaBackButton onClick={onBack} />
        <h3>Persona Marketplace</h3>
      </div>

      <input
        className="persona-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search published personas"
        maxLength={100}
        aria-label="Search published personas"
      />

      {rows.length === 0 ? (
        <p className="persona-empty">
          {busy ? "Loading…" : "No published personas match."}
        </p>
      ) : (
        <div className="persona-market-grid">
          {rows.map((persona) => (
            <button
              key={persona.id}
              type="button"
              className="persona-market-card"
              onClick={() => void open(persona)}
            >
              <span
                className="persona-market-band"
                data-element={personaElement(persona.element)}
              >
                <ElementIcon element={personaElement(persona.element)} size={19} />
              </span>
              <span className="persona-market-name">{persona.name}</span>
              <span className="persona-market-tagline">{persona.tagline ?? ""}</span>
              <span className="persona-market-foot">
                <span className="persona-market-author">@{persona.author}</span>
                <span className="persona-market-installs">
                  {(persona.installs ?? 0).toLocaleString()}{" "}
                  {persona.installs === 1 ? "copy" : "copies"}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {cursor ? (
        <button
          type="button"
          className="text-button persona-more"
          disabled={busy}
          onClick={() => void load(cursor, query, true)}
        >
          Load more
        </button>
      ) : null}
    </div>
  );
}

function PersonaBody({
  persona,
  busy,
  onBack,
  onInstall,
}: {
  persona: Persona;
  busy: boolean;
  onBack: () => void;
  onInstall: () => void;
}) {
  return (
    <>
      <div className="persona-market-head">
        <PersonaBackButton onClick={onBack}>All personas</PersonaBackButton>
        <h3>
          <ElementIcon element={personaElement(persona.element)} size={18} />
          <span>{persona.name}</span>
          {persona.author ? <small>@{persona.author}</small> : null}
        </h3>
      </div>
      {/* Plain text, deliberately: a published tagline and body are another
          reader's words, and rendering them as markdown would hand a stranger
          layout inside this reader's workspace. */}
      <pre className="persona-market-body">{persona.content}</pre>
      <div className="modal-actions">
        <button
          type="button"
          className="primary-button"
          disabled={busy}
          onClick={onInstall}
        >
          Add to my personas
        </button>
      </div>
    </>
  );
}
