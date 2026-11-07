"use client";

/**
 * The two-or-three-way pill toggle, as one component.
 *
 * The sliding thumb is not built here — `.segmented` in `globals.css` already
 * owns it, as a single `::before` that translates between options rather than a
 * background switching on and off under each label. This wrapper exists so the
 * two custom properties that drive it (`--segment-count` sizing the thumb,
 * `--segment-index` positioning it) are computed in one place: they have to
 * agree, and a consumer setting one and forgetting the other gets a thumb that
 * stops halfway.
 *
 * Rendered as a radio group rather than a row of buttons, because that is what
 * it is — a keyboard reader gets arrow-key movement and a single tab stop
 * instead of one stop per option.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className = "",
  disabled = false,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /** Names the choice for assistive technology, e.g. "Ask or find". */
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  // An unrecognised value would leave the thumb under no option at all, which
  // reads as a broken control rather than as an unset one. Fall back to the
  // first option so the thumb is always somewhere.
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  return (
    <div
      className={className ? `segmented ${className}` : "segmented"}
      role="radiogroup"
      aria-label={label}
      style={{
        // Both, always. The thumb's width is `100% / count` and its offset is
        // `index * 100%`, so a count without an index — or the reverse — puts
        // it under the wrong label.
        ["--segment-count" as string]: options.length,
        ["--segment-index" as string]: index,
      }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={disabled}
          className={option.value === value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
