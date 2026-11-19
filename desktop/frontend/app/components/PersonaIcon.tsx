export function PersonaIcon({
  size = 15,
  className,
}: {
  size?: number;
  /** So the settings rail can style it the way it styles every other icon. */
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M8 2a6 6 0 1 0 0 12h1.15a1.35 1.35 0 0 0 0-2.7H8.8a.9.9 0 0 1 0-1.8H10A4 4 0 0 0 10 2Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="5.1" cy="6" r=".75" fill="currentColor" />
      <circle cx="7.4" cy="4.6" r=".75" fill="currentColor" />
      <circle cx="4.8" cy="8.6" r=".75" fill="currentColor" />
    </svg>
  );
}
