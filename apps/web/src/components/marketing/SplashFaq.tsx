import { Trans, useTranslation } from "react-i18next";
import { ChevronDown, HelpCircle } from "lucide-react";
import { DEFAULT_FAQS } from "@thekeep/shared";
import { SPLASH_PANEL_HOVER } from "../../lib/splashPanel.js";

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
  const { t } = useTranslation("marketing");
  function go(e: React.MouseEvent, path: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onNavigate(path);
  }
  // Two independent column stacks (not a row-based grid): expanding an item
  // pushes down only the items below it in its OWN column, never stretching or
  // gapping the other side. Split SEQUENTIALLY so a single-column phone (where
  // the two stacks reflow one below the other) keeps the original reading order.
  const mid = Math.ceil(DEFAULT_FAQS.length / 2);
  const faqColumns = [DEFAULT_FAQS.slice(0, mid), DEFAULT_FAQS.slice(mid)];
  return (
    <section
      aria-label={t("splashFaq.title")}
      className={`rounded-md border border-keep-border/50 bg-keep-panel/30 p-5 sm:p-6 ${SPLASH_PANEL_HOVER}`}
    >
      <div className="mb-4 flex items-center gap-2">
        <HelpCircle className="h-5 w-5 shrink-0 text-keep-accent" aria-hidden />
        <h2 className="font-action text-xl text-keep-text sm:text-2xl">{t("splashFaq.title")}</h2>
      </div>
      <div className="grid items-start gap-2.5 sm:grid-cols-2">
        {faqColumns.map((col, ci) => (
          <div key={ci} className="flex flex-col gap-2.5">
            {col.map((f) => (
              <details
                key={f.slug}
                className="group rounded-md border border-keep-border/40 bg-keep-bg/40 p-3 open:bg-keep-bg/60"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-semibold text-keep-text [&::-webkit-details-marker]:hidden">
                  <span className="md:text-[1.05rem]">{f.question}</span>
                  <ChevronDown
                    className="h-4 w-4 shrink-0 text-keep-muted transition-transform group-open:rotate-180"
                    aria-hidden
                  />
                </summary>
                <p className="mt-2 text-sm leading-relaxed text-keep-text/85">{f.answerMarkdown}</p>
              </details>
            ))}
          </div>
        ))}
      </div>
      <p className="mt-4 text-sm text-keep-muted lg:text-base">
        <Trans t={t} i18nKey="splashFaq.moreQuestion">
          {"Have another question? "}
          <a
            href="/faqs"
            onClick={(e) => go(e, "/faqs")}
            className="text-keep-text/80 underline underline-offset-4 hover:text-keep-action"
          >
            Read the full FAQ
          </a>
          {"."}
        </Trans>
      </p>
    </section>
  );
}
