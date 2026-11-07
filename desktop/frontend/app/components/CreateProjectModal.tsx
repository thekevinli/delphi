"use client";

import { useState } from "react";

/** Names a new project. The caller creates it and decides where the reader goes next. */
export function CreateProjectModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose}>
      <form
        className="modal is-quiet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-project-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          setError("");
          try {
            await onCreate(name.trim());
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Your project could not be created. Try again.");
            setBusy(false);
          }
        }}
      >
        <h2 id="create-project-title">New project</h2>
        <p>A home for related reading. Add documents to it next.</p>
        <label className="modal-field">
          <input
            aria-label="Project name"
            disabled={busy}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Mechanistic interpretability"
            maxLength={100}
            autoFocus
            required
          />
        </label>
        {error ? <p className="modal-error" role="alert">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary-button" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
