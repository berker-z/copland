import type { ReactNode } from "react";

/** One settings page: its title, what it is for, then its controls. */
export function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-bright tracking-[0.08em] mb-1">{title}</h3>
      {hint && <p className="text-xs text-muted mb-4 leading-relaxed">{hint}</p>}
      {children}
    </section>
  );
}

/** A titled group inside a page. */
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-5 first:mt-0">
      <h4 className="text-label mb-2">{title}</h4>
      {children}
    </div>
  );
}

export const input =
  "bg-raised border border-faint px-2 py-1.5 text-ink placeholder:text-faint focus:outline-none focus:border-accent";
export const button =
  "px-3 py-1.5 pointer-coarse:py-2.5 border border-faint text-ink hover:border-accent hover:text-accent transition-colors disabled:opacity-50";
