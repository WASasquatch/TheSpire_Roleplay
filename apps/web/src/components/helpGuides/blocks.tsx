/**
 * Re-usable building blocks for guide bodies, moved verbatim from
 * HelpGuides.tsx. Shared by the canonical English module (./en.tsx) and by
 * translated locale modules (./locales/<lng>.tsx) so every language's
 * guides keep one look. `Tip` takes an optional `label` so a locale module
 * can localize the chip (e.g. <Tip label="Consejo">) without forking the
 * component; the default stays the English "Tip".
 */
import type { ReactNode } from "react";

export function P({ children }: { children: ReactNode }) {
  return <p>{children}</p>;
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="list-decimal space-y-1 pl-5">{children}</ol>;
}

export function Bullets({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
}

export function Tip({ children, label = "Tip" }: { children: ReactNode; label?: string }) {
  return (
    <div className="rounded border border-keep-action/30 bg-keep-action/10 p-2 text-[11px] text-keep-text">
      <span className="mr-1 font-semibold uppercase tracking-widest text-keep-action">{label}</span>
      {children}
    </div>
  );
}

export function K({ children }: { children: ReactNode }) {
  // "Keystroke" - used for slash commands and short code snippets so the
  // body copy stays readable while commands stand out.
  return <code className="rounded bg-keep-panel/60 px-1 font-mono text-[11px] text-keep-action">{children}</code>;
}

export function Heading({ children }: { children: ReactNode }) {
  return <div className="mt-2 font-action text-[13px] uppercase tracking-widest text-keep-muted">{children}</div>;
}
