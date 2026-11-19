"use client";

import { type FormEvent, useState } from "react";

import { api, type AppConfig, type Persona } from "../../lib/api";
import { PERSONA_ELEMENTS, type PersonaElement, personaElement } from "../../lib/personas";
import { ElementIcon } from "../ElementIcon";
import { hint, type Notice } from "../Notice";

/**
 * Writing a persona.
 *
 * Moved out of the picker modal with the rest of persona management, and one
 * behaviour left behind: it no longer selects what it saved. A persona belongs
 * to the conversation being held in it, and the settings sheet has no
 * conversation in view — the reader picks it from a composer afterwards, where
 * they can see what it will answer.
 *
 * `persona` is null for a new one. Starting *from* an official persona is the
 * same thing: the caller prefills `persona` with the official's body and leaves
 * its id off, so saving creates a private copy. That path replaced the old
 * `PUT /skills`, which forked the project's official persona behind the
 * reader's back; without it the officials would be dead ends nobody could begin
 * from.
 */
export function PersonaEditor({
  persona,
  config,
  onCancel,
  onSaved,
  onNotice,
}: {
  /** An owned persona to edit, or a draft to create. `id` decides which. */
  persona: (Partial<Persona> & { content: string }) | null;
  config: AppConfig;
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onNotice: (notice: Notice) => void;
}) {
  const editable = persona?.id ? (persona as Persona) : null;
  const [name, setName] = useState(persona?.name ?? "");
  const [element, setElement] = useState<PersonaElement>(
    personaElement(persona?.element),
  );
  const [tagline, setTagline] = useState(persona?.tagline ?? "");
  const [content, setContent] = useState(persona?.content ?? "");
  const [isPublic, setIsPublic] = useState(persona?.visibility === "public");
  const [saving, setSaving] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    if (!name.trim() || !content.trim()) {
      onNotice(hint("A persona needs a name and instructions"));
      return;
    }
    void save();
  };

  const save = async () => {
    setSaving(true);
    const fields = {
      name: name.trim(),
      element,
      tagline: tagline.trim() || null,
      content: content.trim(),
      // Memory is account-wide and always on; personas no longer declare a
      // memory capability. Empty keeps stored rows honest after the sunset.
      capabilities: [] as string[],
      visibility: isPublic ? "public" : "private",
    };
    try {
      if (editable) {
        await api<Persona>(`/api/personas/${editable.id}`, {
          method: "PATCH",
          // The revision this form was opened on. A concurrent save in another
          // tab is answered with 409 rather than silently overwritten.
          body: JSON.stringify({ ...fields, expected_revision: editable.revision }),
        });
      } else {
        await api<Persona>("/api/personas", {
          method: "POST",
          body: JSON.stringify(fields),
        });
      }
      await onSaved();
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "Could not save that persona",
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editable) return;
    setSaving(true);
    try {
      await api(`/api/personas/${editable.id}`, { method: "DELETE" });
      await onSaved();
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "Could not delete that persona",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="persona-editor-pane" onSubmit={submit}>
      <div className="persona-editor-scroll">
        <header className="persona-settings-heading">
          <button type="button" className="persona-editor-back" aria-label="Back to Persona" onClick={onCancel} disabled={saving}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m10 3-5 5 5 5" /></svg>Persona
          </button>
          <h3>{editable ? "Edit persona" : "New persona"}</h3>
        </header>
        {editable ? <p className="persona-usage">Your conversations use these instructions from their next turn.</p> : null}
        <div className="persona-editor-fields">
          <div className="persona-identity">
            <label className="persona-field"><span>Name</span>
              <input value={name} maxLength={config.personaMaxNameCharacters} onChange={event => setName(event.target.value)} placeholder="e.g. Skeptical reviewer" autoFocus required />
            </label>
            <div className="persona-field persona-icon-field"><span id="persona-icon-label">Icon</span>
              <div className="persona-element-picker" role="radiogroup" aria-labelledby="persona-icon-label">
                {PERSONA_ELEMENTS.map(option => <button key={option} type="button" role="radio" aria-checked={element === option} aria-label={option}
                  tabIndex={element === option ? 0 : -1} className={element === option ? "active" : ""}
                  onKeyDown={event => {
                    const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
                    if (!direction && event.key !== "Home" && event.key !== "End") return;
                    event.preventDefault();
                    const index = event.key === "Home" ? 0 : event.key === "End" ? PERSONA_ELEMENTS.length - 1 : (PERSONA_ELEMENTS.indexOf(option) + direction + PERSONA_ELEMENTS.length) % PERSONA_ELEMENTS.length;
                    setElement(PERSONA_ELEMENTS[index]);
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[index]?.focus();
                  }} onClick={() => setElement(option)}><ElementIcon element={option} size={16} /></button>)}
              </div>
            </div>
          </div>
          <label className="persona-field"><span>One-line description</span>
            <input value={tagline} maxLength={config.personaMaxTaglineCharacters} onChange={event => setTagline(event.target.value)} placeholder="What reading with this persona is like" />
          </label>
          <label className="persona-field persona-instructions">
            <span className="persona-instructions-label"><span>Instructions</span><span className="persona-count" aria-live="polite">{content.length.toLocaleString()} / {config.personaMaxCharacters.toLocaleString()}</span></span>
            <textarea value={content} maxLength={config.personaMaxCharacters} onChange={event => setContent(event.target.value)} required
              placeholder={`# How to answer
- Ground claims in the supplied papers and cite pages.
- Explain intuition before mathematical detail.
- Define specialist terminology on first use.`} />
          </label>
        </div>
      </div>
      <footer className="persona-editor-footer">
        {config.personaMarketplaceEnabled ? <label className="persona-toggle">
          <input type="checkbox" checked={isPublic} onChange={event => setIsPublic(event.target.checked)} />
          <span>Publish to marketplace <small>Anyone can copy it</small></span>
        </label> : null}
        {editable ? <button type="button" className="text-button skills-remove" disabled={saving} onClick={() => void remove()}>Delete</button> : null}
        <div className="persona-editor-actions">
          <button type="button" className="secondary-button" disabled={saving} onClick={onCancel}>Cancel</button>
          <button className="primary-button" disabled={saving || !name.trim() || !content.trim()}>{saving ? "Saving…" : editable ? "Save" : "Create persona"}</button>
        </div>
      </footer>
    </form>
  );
}
