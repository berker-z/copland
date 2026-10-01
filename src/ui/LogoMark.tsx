/* ============================================================================
   The Copland mark: the utility pole from Serial Experiments Lain, with its
   wires sagging off the right edge. Drawn on a 16-unit grid, so it is crisp
   at 16px and 32px and soft anywhere between; keep it at those sizes.

   Inline rather than an <img> so it takes currentColor and follows the
   theme. The wires can take a second tone through --mark-2 on any parent;
   by default they match the pole. The favicon is the same drawing with nord
   colours baked in (public/favicon.svg).
   ========================================================================== */

export function LogoMark({ size = 16, className }: { size?: 16 | 32; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden>
      <path fill="currentColor" d="M4 0h2v3h4v2H6v3h2v1H6v7H4V9H2V8h2V5H0V3h4z" />
      <path
        fill="none"
        strokeWidth={1}
        style={{ stroke: "var(--mark-2, currentColor)" }}
        d="M8.4 4.51A22.97 22.97 0 0 0 17.5 8.53M0.39 4.68A28.56 28.56 0 0 0 17.5 14.21"
      />
    </svg>
  );
}
