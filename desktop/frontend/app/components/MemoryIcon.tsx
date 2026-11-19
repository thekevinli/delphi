/** The shared Memory mark: three pages connected as one graph. */
export function MemoryIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" aria-hidden="true">
      <circle cx="10" cy="4.4" r="2.1" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.6" cy="14.6" r="2.1" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="15.4" cy="14.6" r="2.1" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8.9 6.3 5.7 12.7m5.4-6.4 3.2 6.4M6.7 14.6h6.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
