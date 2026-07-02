import { useEffect, useState } from "react";
import { fetchPublicAffiliates, type PublicAffiliateCard } from "../lib/affiliates.js";
import { AffiliateCard } from "./AffiliateCard.js";
import { SubmitAffiliateButton } from "./AffiliateSubmitPortal.js";
import { SPLASH_PANEL, SPLASH_PANEL_HOVER } from "../lib/splashPanel.js";

/**
 * "Top RP Communities" section — the public face of the topsite board on the
 * splash right-hand meta rail, beneath the Scriptorium bookshelf. Shows the top
 * few approved partner cards (ranked by traffic) as a compact single-column
 * stack, a "List your community" CTA, and a link to the full /top-communities
 * board.
 *
 * Legacy raw-HTML badges are NOT shown here — those are archival, managed only
 * from the admin panel. When there are zero approved cards we still show the
 * header + a compact empty-state prompt + the CTA (never an empty box). The whole
 * section only bails on a hard fetch failure.
 */
export function RoleplayCommunities({ onNavigate: _onNavigate }: { onNavigate?: (path: string) => void } = {}) {
  const [cards, setCards] = useState<PublicAffiliateCard[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPublicAffiliates()
      .then((res) => { if (!cancelled) setCards(res.cards); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  if (failed) return null;

  const loading = cards === null;
  const isEmpty = !loading && cards.length === 0;

  return (
    <section aria-label="Top RP Communities" className={`w-full p-4 sm:p-5 ${SPLASH_PANEL} ${SPLASH_PANEL_HOVER}`}>
      <header className="mb-3 text-center">
        <h3 className="font-action text-lg text-keep-text">Top RP Communities</h3>
        <p className="mt-0.5 text-xs text-keep-muted">
          Sister sites and partner communities. Give us a look, and list your own.
        </p>
      </header>

      {loading ? (
        <p className="py-4 text-center text-xs italic text-keep-muted">Gathering communities…</p>
      ) : isEmpty ? (
        <div className="rounded border border-dashed border-keep-rule bg-keep-panel/30 px-4 py-6 text-center">
          <p className="text-xs text-keep-muted">
            No partner communities yet. Be the first to list yours.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {cards.slice(0, 6).map((card) => (
            <AffiliateCard key={card.id} card={card} />
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-col items-center gap-2">
        <SubmitAffiliateButton />
        <a
          href="/top-communities"
          className="text-xs text-keep-muted underline underline-offset-4 hover:text-keep-action"
        >
          Browse all communities →
        </a>
      </div>
    </section>
  );
}
