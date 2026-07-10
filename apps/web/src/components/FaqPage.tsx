import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { useTranslation } from "react-i18next";
import type { FaqEntry } from "@thekeep/shared";
import type { FaqRoute } from "../lib/faqUrl.js";
import { navigateAwayFromFaq } from "../lib/faqUrl.js";
import { useChat } from "../state/store.js";
import { resolveSplashTheme, themeStyle } from "../lib/theme.js";

/** `?serverId=<active server>` so the FAQ shows THIS server's entries; empty
 *  when there's no active server (a logged-out / shared link), where the backend
 *  falls back to the default/system server's FAQ. */
function faqServerQuery(serverId: string | null): string {
  return serverId ? `?serverId=${encodeURIComponent(serverId)}` : "";
}

/**
 * Public, no-auth-required FAQ pages.
 *
 * Mounted by App.tsx (BEFORE AuthGate) when the URL is `/faqs` (index) or
 * `/faq/<slug>` (single entry), so a mod can link an answer to anyone,
 * signed-in or not. Content comes from the public `/api/faqs*` endpoints
 * (enabled rows only). Answer HTML is sanitized server-side on save; we
 * re-sanitize with DOMPurify on render as defense in depth.
 */
export function FaqPage({ route }: { route: FaqRoute }) {
  return route.kind === "index" ? <FaqIndex /> : <FaqEntryView slug={route.slug} />;
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useTranslation("marketing");
  // Apply the site's splash palette so this standalone public page matches the
  // rest of the site instead of the flat light :root defaults (keep-* vars are
  // otherwise unset on this route, since the authed shell never mounts here).
  const branding = useChat((s) => s.branding);
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => { document.title = previous; };
  }, [title]);
  return (
    <main
      style={themeStyle(resolveSplashTheme(branding))}
      className="min-h-screen w-full bg-keep-bg px-4 py-6 text-keep-text md:py-10"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <header className="flex items-baseline justify-between gap-2 border-b border-keep-border pb-3">
          <h1 className="font-action text-2xl">{title}</h1>
          <a
            href="/"
            onClick={(e) => { e.preventDefault(); navigateAwayFromFaq(); }}
            className="text-sm text-keep-muted hover:text-keep-action"
          >
            {t("backLink")}
          </a>
        </header>
        <div className="keep-frame rounded border border-keep-rule bg-keep-panel/40 px-5 py-4 md:px-6 md:py-5">
          {children}
        </div>
      </div>
    </main>
  );
}

function FaqIndex() {
  const { t } = useTranslation("marketing");
  const [faqs, setFaqs] = useState<FaqEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentServerId = useChat((s) => s.currentServerId);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/faqs${faqServerQuery(currentServerId)}`, { credentials: "include" })
      .then(async (r) => { if (!r.ok) throw new Error(t("faqPage.statusError", { status: r.status })); return r.json() as Promise<{ faqs: FaqEntry[] }>; })
      .then((j) => { if (!cancelled) setFaqs(j.faqs); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : t("faqPage.loadFailed")); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentServerId]);

  // Group by category (uncategorized last), preserving server sort order.
  const groups = new Map<string, FaqEntry[]>();
  for (const f of faqs ?? []) {
    const key = f.category?.trim() || "";
    const arr = groups.get(key) ?? [];
    arr.push(f);
    groups.set(key, arr);
  }
  const ordered = [...groups.entries()].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : 0));

  return (
    <Shell title={t("faqPage.title")}>
      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
      ) : faqs === null ? (
        <p className="italic text-keep-muted">{t("common:loading")}</p>
      ) : faqs.length === 0 ? (
        <p className="italic text-keep-muted">{t("faqPage.empty")}</p>
      ) : (
        <div className="space-y-5">
          {ordered.map(([category, entries]) => (
            <section key={category || "_uncat"}>
              {category ? (
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-keep-muted">{category}</h2>
              ) : null}
              <ul className="space-y-1">
                {entries.map((f) => (
                  <li key={f.id}>
                    <a href={`/faq/${f.slug}`} className="text-keep-action hover:underline">{f.question}</a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Shell>
  );
}

function FaqEntryView({ slug }: { slug: string }) {
  const { t } = useTranslation("marketing");
  const [faq, setFaq] = useState<FaqEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentServerId = useChat((s) => s.currentServerId);

  useEffect(() => {
    let cancelled = false;
    setFaq(null); setError(null);
    fetch(`/api/faqs/${encodeURIComponent(slug)}${faqServerQuery(currentServerId)}`, { credentials: "include" })
      .then(async (r) => {
        if (r.status === 404) throw new Error(t("faqPage.notFound"));
        if (!r.ok) throw new Error(t("faqPage.statusError", { status: r.status }));
        return r.json() as Promise<{ faq: FaqEntry }>;
      })
      .then((j) => { if (!cancelled) setFaq(j.faq); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : t("faqPage.loadFailed")); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, currentServerId]);

  return (
    <Shell title={faq ? faq.question : t("faqPage.title")}>
      {error ? (
        <div className="space-y-3">
          <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
          <a href="/faqs" className="text-sm text-keep-action hover:underline">{t("faqPage.allFaqs")}</a>
        </div>
      ) : faq === null ? (
        <p className="italic text-keep-muted">{t("common:loading")}</p>
      ) : (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-keep-text">{faq.question}</h2>
          <div
            className="prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(faq.answerHtml) }}
          />
          <a href="/faqs" className="inline-block text-sm text-keep-action hover:underline">{t("faqPage.allFaqs")}</a>
        </div>
      )}
    </Shell>
  );
}
