import { useEffect, useState } from "react";
import type { StoryEntity, StoryEntityKind } from "@thekeep/shared";

/**
 * Reader-side "Cast & Places" appendix. Surfaces a story's PUBLIC
 * codex entities at the bottom of the reader, grouped by kind. Hidden
 * entirely when the story has no public entries (private codex
 * entries — author notes, plot outlines — never reach this surface).
 */
export function StoryCodexAppendix({ storyId }: { storyId: string }) {
  const [entities, setEntities] = useState<StoryEntity[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/stories/${storyId}/codex`)
      .then(async (r) => (r.ok ? ((await r.json()) as { entities: StoryEntity[] }) : null))
      .then((j) => { if (!cancelled && j) setEntities(j.entities.filter((e) => e.isPublic)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [storyId]);

  if (!entities || entities.length === 0) return null;

  // Group by kind for display. Plot entries aren't surfaced even if
  // marked public — they're spoiler territory by their nature. Authors
  // who want plot points readable can move them into a separate
  // "character" or "location" entry instead.
  const characters = entities.filter((e) => e.kind === "character");
  const locations = entities.filter((e) => e.kind === "location");
  if (characters.length === 0 && locations.length === 0) return null;

  return (
    <section className="mx-auto mt-10 max-w-prose border-t border-current/20 pt-5">
      <h3 className="mb-3 font-action text-lg">Cast &amp; Places</h3>
      {characters.length > 0 ? (
        <KindList kind="character" entities={characters} openId={openId} onToggle={(id) => setOpenId(openId === id ? null : id)} />
      ) : null}
      {locations.length > 0 ? (
        <KindList kind="location" entities={locations} openId={openId} onToggle={(id) => setOpenId(openId === id ? null : id)} />
      ) : null}
    </section>
  );
}

function KindList({
  kind,
  entities,
  openId,
  onToggle,
}: {
  kind: StoryEntityKind;
  entities: StoryEntity[];
  openId: string | null;
  onToggle: (id: string) => void;
}) {
  const heading = kind === "character" ? "Characters" : kind === "location" ? "Places" : "Plot";
  return (
    <div className="mb-5">
      <h4 className="mb-2 text-xs uppercase tracking-widest opacity-70">{heading}</h4>
      <ul className="space-y-2">
        {entities.map((e) => (
          <li
            key={e.id}
            // id="codex-character-<slug>" so `@char:slug` chips in
            // chapter prose can scroll to + flash this entry. Same
            // pattern for location entries even though the chip kind
            // is `char`; future chip kinds (e.g. `@place:slug`) would
            // get their own prefix.
            id={kind === "character" ? `codex-character-${e.slug}` : undefined}
            className="rounded border border-current/20 bg-keep-panel/20 p-3 transition-shadow"
          >
            <button
              type="button"
              onClick={() => onToggle(e.id)}
              className="flex w-full items-start gap-3 text-left"
            >
              {e.imageUrl ? (
                <img
                  src={e.imageUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="h-12 w-12 shrink-0 rounded object-cover"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <h5 className="font-action text-base">{e.name}</h5>
                  {Object.keys(e.stats).length > 0 && kind === "character" ? (
                    <span className="text-[10px] italic opacity-60">
                      {Object.entries(e.stats)
                        .filter(([k]) => k !== "status")
                        .slice(0, 3)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(" · ")}
                    </span>
                  ) : null}
                </div>
                {e.summary ? <p className="text-sm opacity-80">{e.summary}</p> : null}
              </div>
            </button>
            {openId === e.id && e.bodyHtml ? (
              <div
                className="prose prose-sm mt-2 max-w-none border-t border-current/15 pt-2 text-sm"
                dangerouslySetInnerHTML={{ __html: e.bodyHtml }}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
