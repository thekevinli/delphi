import type { ReactElement } from "react";
import type { PersonaElement } from "../lib/personas";

/**
 * The glyph that stands for a persona.
 *
 * Drawn rather than imported, matching every other icon here: one 16×16 box,
 * `stroke="currentColor"`, 1.3 weight. Colour arrives through the `element-*`
 * class rather than a fill, so a persona row, a picker card and the composer all
 * tint the same mark from one token.
 */
const PATHS: Record<PersonaElement, ReactElement> = {
  fire: (
    <>
      <path d="M8 2.1c2.4 2.3 3.9 4.2 3.9 6a3.9 3.9 0 1 1-7.8 0c0-1 .4-2 1.1-2.9.2 1.1.8 1.8 1.6 2C6.5 5.5 7 3.8 8 2.1Z" />
      <path d="M8 8.2c.9.9 1.4 1.6 1.4 2.3a1.4 1.4 0 1 1-2.8 0c0-.7.5-1.4 1.4-2.3Z" />
    </>
  ),
  water: (
    <>
      <path d="M8 2.3c2.4 2.9 3.7 4.9 3.7 6.4a3.7 3.7 0 1 1-7.4 0c0-1.5 1.3-3.5 3.7-6.4Z" />
      <path d="M5.9 9.4a2.1 2.1 0 0 0 1.5 2" />
    </>
  ),
  leaf: (
    <>
      <path d="M13 3c0 5.1-3.5 8.5-7.8 8.5-1 0-1.9-.2-2.6-.7C2.6 5.8 6.1 2.5 10.4 2.5c1 0 1.9.2 2.6.5Z" />
      <path d="M12.3 3.7 3.3 12.4" />
    </>
  ),
  bolt: (
    <>
      <path d="M9.3 1.8 4.2 8.9h3.3l-.8 5.3L11.8 7H8.5l.8-5.2Z" />
    </>
  ),
  stone: (
    <>
      <path d="M3.3 3h9.4l2 3.4L8 14 1.3 6.4 3.3 3Z" />
      <path d="M1.3 6.4h13.4M6 3 4.8 6.4 8 14l3.2-7.6L10 3" />
    </>
  ),
  wind: (
    <>
      <path d="M2.2 5.4h6.5a1.9 1.9 0 1 0-1.9-2.1" />
      <path d="M2.2 8.4h8.6a2 2 0 1 1-1.9 2.2" />
      <path d="M2.2 11.4h4.4" />
    </>
  ),
};

export function ElementIcon({
  element,
  size = 15,
}: {
  element: PersonaElement;
  size?: number;
}) {
  return (
    <svg
      className={`element-icon element-${element}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[element] ?? PATHS.stone}
    </svg>
  );
}
