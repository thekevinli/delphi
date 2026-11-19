/**
 * The welcome screen's artwork: a webpage, a dashboard and a PDF, stacked, that
 * fan open, hold, and close again every five seconds. Drawn at 68×88 from a
 * 168×216 canvas; the motion is in `.onboarding-fan-card` in globals.css.
 *
 * Each card is a few shapes, not a miniature of a real page: on a calm screen
 * the cards say "webpage, chart, paper" and nothing more. Three colours only —
 * the paper, a pale rose tint for blocks, and a soft rosewood for the one or
 * two marks that make each card what it is.
 */
const PAPER = "#FBF6F0";
const INK = "#B5554C";
const TINT = "#F3DDD7";
const HAIR = "#E9D3CC";

export function OnboardingFan() {
  return <div className="onboarding-fan" aria-hidden="true">
    {/* A webpage: window dots, a hero, a headline, two lines of text. */}
    <div className="onboarding-fan-card onboarding-fan-l">
      <svg width="68" height="88" viewBox="0 0 168 216">
        <rect width="168" height="216" fill={PAPER} />
        <circle cx="18" cy="18" r="4" fill={HAIR} /><circle cx="30" cy="18" r="4" fill={HAIR} /><circle cx="42" cy="18" r="4" fill={HAIR} />
        <rect x="16" y="40" width="136" height="70" rx="8" fill={TINT} />
        <rect x="16" y="128" width="112" height="9" rx="4.5" fill={INK} />
        <rect x="16" y="150" width="136" height="5" rx="2.5" fill={HAIR} />
        <rect x="16" y="164" width="96" height="5" rx="2.5" fill={HAIR} />
      </svg>
    </div>
    {/* A dashboard: a title, one rising line, four bars. */}
    <div className="onboarding-fan-card onboarding-fan-c">
      <svg width="68" height="88" viewBox="0 0 168 216">
        <rect width="168" height="216" fill={PAPER} />
        <rect x="16" y="20" width="60" height="9" rx="4.5" fill={INK} />
        <path d="M18 104 L52 84 L84 92 L118 62 L150 50" fill="none" stroke={INK} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="18" y="150" width="20" height="44" rx="4" fill={TINT} />
        <rect x="48" y="132" width="20" height="62" rx="4" fill={TINT} />
        <rect x="78" y="160" width="20" height="34" rx="4" fill={TINT} />
        <rect x="108" y="122" width="20" height="72" rx="4" fill={INK} opacity="0.55" />
      </svg>
    </div>
    {/* A PDF: a centred title, its abstract, and the body. */}
    <div className="onboarding-fan-card onboarding-fan-r">
      <svg width="68" height="88" viewBox="0 0 168 216">
        <rect width="168" height="216" fill={PAPER} />
        <rect x="34" y="26" width="100" height="9" rx="4.5" fill={INK} />
        <rect x="54" y="44" width="60" height="5" rx="2.5" fill={HAIR} />
        <rect x="16" y="68" width="136" height="40" rx="6" fill={TINT} />
        <rect x="16" y="128" width="136" height="5" rx="2.5" fill={HAIR} />
        <rect x="16" y="142" width="136" height="5" rx="2.5" fill={HAIR} />
        <rect x="16" y="156" width="136" height="5" rx="2.5" fill={HAIR} />
        <rect x="16" y="170" width="88" height="5" rx="2.5" fill={HAIR} />
      </svg>
    </div>
  </div>;
}
