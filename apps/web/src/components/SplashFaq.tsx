import { ChevronDown, HelpCircle } from "lucide-react";
import { DEFAULT_FAQS } from "@thekeep/shared";
import { SPLASH_PANEL_HOVER } from "../lib/splashPanel.js";

/**
 * Static FAQ block for the splash. Renders the shared {@link DEFAULT_FAQS} as a
 * two-column native `<details>` list — plain, crawlable HTML with no fetch and
 * no JS gating, so search engines index the Q&A text on first load (the splash
 * is otherwise a client-rendered SPA). This is the same starter set seeded into
 * the `/faqs` system on first boot; the full, admin-editable FAQ lives at
 * `/faqs`, linked below.
 *
 * Answers are plain prose (no em dashes / dev jargon, per the help-content
 * voice) so they read cleanly and stay in sync with the seeded Markdown source.
 */
export function SplashFaq({ onNavigate }: { onNavigate: (path: string) => void }) {
  function go(e: React.MouseEvent, path: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onNavigate(path);
  }
  return (
    <section
      aria-label="Frequently asked questions"
      className={`rounded-md border border-keep-border/50 bg-keep-panel/30 p-5 sm:p-6 ${SPLASH_PANEL_HOVER}`}
    >
      <div className="mb-4 flex items-center gap-2">
        <HelpCircle className="h-5 w-5 shrink-0 text-keep-accent" aria-hidden />
        <h2 className="font-action text-xl text-keep-text sm:text-2xl">Frequently asked questions</h2>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {DEFAULT_FAQS.map((f) => (
          <details
            key={f.slug}
            className="group rounded-md border border-keep-border/40 bg-keep-bg/40 p-3 open:bg-keep-bg/60"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-semibold text-keep-text [&::-webkit-details-marker]:hidden">
              <span>{f.question}</span>
              <ChevronDown
                className="h-4 w-4 shrink-0 text-keep-muted transition-transform group-open:rotate-180"
                aria-hidden
              />
            </summary>
            <p className="mt-2 text-sm leading-relaxed text-keep-text/85">{f.answerMarkdown}</p>
          </details>
        ))}
      </div>
      <p className="mt-4 text-sm text-keep-muted lg:text-base">
        Have another question?{" "}
        <a
          href="/faqs"
          onClick={(e) => go(e, "/faqs")}
          className="text-keep-text/80 underline underline-offset-4 hover:text-keep-action"
        >
          Read the full FAQ
        </a>
        .
      </p>
    </section>
  );
}
