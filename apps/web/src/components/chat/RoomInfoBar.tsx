import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Drama,
  Info,
  Megaphone,
  MessagesSquare,
  Pin,
  PinOff,
  ScrollText,
  Users,
} from "lucide-react";
import type { PinnedMessage, RoomInfo, RoomSummary } from "@thekeep/shared";
import { customCmdCssToStyle, resolveMessageColor } from "@thekeep/shared";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard.js";
import { useReducedMotion } from "../../lib/reducedMotion.js";
import { fetchRoomInfo } from "../../lib/rooms.js";
import { parseInline } from "../../lib/markdown.js";
import { useActiveTheme } from "../../lib/theme.js";
import { useMarqueeHidden, resurrectMarquee } from "../../lib/marqueeVisibility.js";

interface Props {
  room: RoomSummary;
  /** True when the viewer can edit this room (owner/mod/admin). Drives the
   *  "add one with /describe" setup hints under empty sections — text only,
   *  not an inline editor. */
  canEdit?: boolean;
  /** Open the linked-world viewer from the metadata grid. */
  onOpenWorld?: (worldId: string) => void;
  /** Pinned messages for this room (migration 0316). Renders a collapsible
   *  strip above the room bar. Empty/absent → no strip. */
  pins?: PinnedMessage[];
  /** Viewer can unpin (sitewide `pin_message` or room owner/mod). Surfaces
   *  the Unpin button on each pin row. Read-only viewers still see + jump. */
  canPinMessage?: boolean;
  /** Jump the chat to a pinned message (flash it). Null messageId (source
   *  hard-deleted) rows render non-clickable. */
  onJumpToMessage?: (messageId: string) => void;
  /** Unpin a pin. Receives the live source message id when it still exists,
   *  or the pin row's own id when the source was hard-deleted (the DELETE
   *  route resolves either). Wired to `DELETE /messages/:id/pin`. */
  onUnpin?: (idForUnpin: string) => void;
}

/** True when the icon string should render as an <img> rather than a glyph. */
function isImageIcon(icon: string | null | undefined): boolean {
  return !!icon && /^https?:\/\//i.test(icon);
}

function fmtCreated(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "-";
  }
}

/** Beveled vertical separator: a 1px dark rule with a 1px light highlight to
 *  its right, giving the carved/raised "shadow highlight" edge. */
function Bevel() {
  return (
    <span
      aria-hidden
      className="mx-2 my-1 w-px self-stretch bg-keep-rule/70 shadow-[1px_0_0_rgba(255,255,255,0.08)]"
    />
  );
}

/**
 * The Room Info bar: a clickable strip at the top of the chat column showing
 * `[icon] Room name │ topic │ Created · N messages │ ⌄`. Clicking anywhere on
 * the bar expands a condensed dossier pullout (description + metadata side by
 * side, plus current scene and the NPC roster). The heavier data is lazy-
 * fetched from GET /rooms/:id/info on first expand. The icon is set via the
 * `/icon` command (no inline editor here, by design).
 */
export function RoomInfoBar({ room, canEdit = false, onOpenWorld, pins, canPinMessage = false, onJumpToMessage, onUnpin }: Props) {
  const [expanded, setExpanded] = useState(false);
  // Pins strip: collapsed to a "N pinned" summary by default, expands to a
  // scrollable list. Independent of the room-details pullout below.
  const [pinsExpanded, setPinsExpanded] = useState(false);
  const roomPins = pins ?? [];
  // Calm-mode ease: the dossier pullout opens BELOW the room bar and mounts
  // fresh on expand, so it slides down gently under Reduce Motion. Block-flow
  // positioned (no transform placement), so the slide transform is safe.
  const reduceMotion = useReducedMotion();
  const [info, setInfo] = useState<RoomInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // True when site announcements exist but the viewer dismissed them —
  // drives the "bring back announcements" button in the bar.
  const marqueeHidden = useMarqueeHidden();

  // Lazy-load the dossier the first time the bar is expanded. Cheap — one
  // fetch per open, gated behind a deliberate click.
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchRoomInfo(room.id)
      .then((i) => { if (!cancelled) setInfo(i); })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, room.id]);

  // Collapse + drop any cached dossier when the room changes, so a stale
  // pullout from the previous room never flashes under the new one's bar.
  useEffect(() => {
    setExpanded(false);
    setInfo(null);
    setPinsExpanded(false);
  }, [room.id]);

  const bannerText = room.topic
    ? room.topic
    : room.currentSceneTitle
      ? `Scene: ${room.currentSceneTitle}`
      : null;

  return (
    <div className="border-b border-keep-rule bg-keep-banner/40">
      {/* Pinned-messages strip. Collapsed to a "N pinned" summary; expands to
          a scrollable list rendered like bookmark rows (color / cmd CSS
          preserved), each with jump + (privileged) unpin. Sits above the room
          bar so it reads as the room's pinned notices. */}
      {roomPins.length > 0 ? (
        <div className="border-b border-keep-rule/60 bg-keep-bg/30">
          <button
            type="button"
            onClick={() => setPinsExpanded((v) => !v)}
            aria-expanded={pinsExpanded}
            className="flex w-full items-center gap-2 px-3 py-1 text-xs text-keep-muted hover:bg-keep-banner/40"
            title={pinsExpanded ? "Hide pinned messages" : "Show pinned messages"}
          >
            <Pin size={12} aria-hidden />
            <span className="font-action tracking-wide text-keep-text">
              {roomPins.length} pinned
            </span>
            <span className="ml-auto">
              {pinsExpanded ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
            </span>
          </button>
          {pinsExpanded ? (
            <ul className={`max-h-60 divide-y divide-keep-rule/40 overflow-y-auto${reduceMotion ? " tk-slide-down-in" : ""}`}>
              {roomPins.map((p) => (
                <PinRow
                  key={p.id}
                  pin={p}
                  canUnpin={canPinMessage}
                  {...(onJumpToMessage ? { onJump: onJumpToMessage } : {})}
                  {...(onUnpin ? { onUnpin } : {})}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {/* Clickable bar — the whole strip toggles the pullout. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={expanded ? "Hide room details" : "Show room details"}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        className="flex w-full cursor-pointer items-stretch px-3 py-1.5 text-sm hover:bg-keep-banner/60"
        title={expanded ? "Click to hide room details" : "Click for room details"}
      >
        {/* Left: icon + name */}
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          {room.icon ? (
            isImageIcon(room.icon) ? (
              <img
                src={room.icon}
                alt=""
                className="h-5 w-5 shrink-0 rounded object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span aria-hidden className="text-base leading-none">{room.icon}</span>
            )
          ) : null}
          <span className="truncate font-action tracking-wide text-keep-text">{room.name}</span>
        </div>

        <Bevel />

        {/* Middle: topic / banner (truncates) */}
        <div className="flex min-w-0 flex-1 items-center">
          {bannerText ? (
            <span className="truncate italic text-keep-muted">{bannerText}</span>
          ) : (
            <span className="truncate text-keep-muted/50">
              No topic set{canEdit ? " - add one with /topic" : ""}
            </span>
          )}
        </div>

        <Bevel />

        {/* Right: quick stats + chevron */}
        <div className="flex shrink-0 items-center gap-3 text-xs text-keep-muted">
          <span className="hidden items-center gap-1 sm:flex" title="Room created">
            <Clock size={12} aria-hidden />
            {fmtCreated(room.createdAt)}
          </span>
          <span className="flex items-center gap-1" title="Messages ever sent here">
            <MessagesSquare size={12} aria-hidden />
            {room.messageCount.toLocaleString()}
          </span>
          {marqueeHidden ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); resurrectMarquee(); }}
              className="flex items-center gap-1 rounded border border-keep-action/40 bg-keep-action/15 px-1.5 py-0.5 text-keep-action hover:border-keep-action hover:bg-keep-action/30"
              title="Bring back the announcements banner you hid"
              aria-label="Bring back announcements"
            >
              <Megaphone size={12} aria-hidden />
              <span className="hidden sm:inline">Announcements</span>
            </button>
          ) : null}
          {expanded ? <ChevronUp size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
        </div>
      </div>

      {/* Pullout — condensed dossier. Description and metadata sit side by side
          on wide screens; everything stacks on mobile. */}
      {expanded ? (
        <div className={`border-t border-keep-rule/60 bg-keep-bg/40 px-3 py-2${reduceMotion ? " tk-slide-down-in" : ""}`}>
          {loading ? (
            <div className="py-1 text-center text-xs text-keep-muted">Loading room details…</div>
          ) : error || !info ? (
            <div className="py-1 text-center text-xs text-keep-muted">Couldn't load room details.</div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {/* Sections always render — empty ones show a placeholder (and,
                  for editors, a "/command" setup hint) instead of vanishing, so
                  the dossier reads the same whether or not a room is filled in.
                  Description: wide column on the left; metadata flows to its
                  right (next cell) so the horizontal space is used. */}
              <Card icon={<ScrollText size={12} aria-hidden />} title="Description" className="lg:col-span-2">
                {info.description ? (
                  <p className="whitespace-pre-wrap text-xs leading-snug text-keep-text/90">{info.description}</p>
                ) : (
                  <Empty text="No description added." hint={canEdit ? "Add one with /describe <text>" : null} />
                )}
              </Card>

              <Card icon={<Info size={12} aria-hidden />} title="Details">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs leading-tight">
                  <Meta label="Type" value={info.type === "private" ? "Private 🔒" : "Public"} />
                  {info.slug ? <LinkRow slug={info.slug} /> : null}
                  {info.ownerName ? <Meta label="Owner" value={info.ownerName} /> : null}
                  <Meta label="Created" value={fmtCreated(info.createdAt)} />
                  <Meta label="Messages" value={info.messageCount.toLocaleString()} />
                  {info.messageExpiryMinutes && info.messageExpiryMinutes > 0 ? (
                    <Meta label="Auto-expire" value={`${info.messageExpiryMinutes} min`} />
                  ) : null}
                  {info.difficultyClass != null ? (
                    <Meta label="Roll DC" value={String(info.difficultyClass)} />
                  ) : null}
                  {info.theaterMode ? <Meta label="Theater" value="On" /> : null}
                  {info.linkedWorld ? (
                    <>
                      <dt className="text-keep-muted">World</dt>
                      <dd className="truncate">
                        {onOpenWorld ? (
                          <button
                            type="button"
                            onClick={() => onOpenWorld(info.linkedWorld!.id)}
                            className="text-keep-action underline hover:text-keep-action/80"
                          >
                            {info.linkedWorld.name}
                          </button>
                        ) : (
                          info.linkedWorld.name
                        )}
                      </dd>
                    </>
                  ) : null}
                </dl>
              </Card>

              <Card icon={<Drama size={12} aria-hidden />} title="Current scene">
                {info.currentScene ? (
                  <>
                    <p className="text-xs leading-snug text-keep-text/90">{info.currentScene.title}</p>
                    {info.currentScene.imageUrl ? (
                      <img
                        src={info.currentScene.imageUrl}
                        alt=""
                        className="mt-1.5 max-h-28 w-full rounded object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : null}
                  </>
                ) : (
                  <Empty text="No current scene." hint={canEdit ? "Set the scene with /scene <title>" : null} />
                )}
              </Card>

              <Card icon={<Users size={12} aria-hidden />} title={info.npcs.length > 0 ? `NPCs (${info.npcs.length})` : "NPCs"}>
                {info.npcs.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {info.npcs.map((n) => (
                      <span
                        key={n}
                        className="rounded bg-keep-banner/70 px-1.5 py-0.5 text-[11px] text-keep-text"
                      >
                        {n}
                      </span>
                    ))}
                  </div>
                ) : (
                  <Empty text="No NPCs voiced here yet." hint={canEdit ? "Voice one with /npc <Name> <text>" : null} />
                )}
              </Card>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** A titled cell in the pullout grid. */
function Card({ icon, title, className, children }: { icon: ReactNode; title: string; className?: string; children: ReactNode }) {
  return (
    <section className={`rounded border border-keep-rule/50 bg-keep-banner/20 p-2 ${className ?? ""}`}>
      <h4 className="mb-1 flex items-center gap-1.5 text-[10px] font-action uppercase tracking-widest text-keep-muted">
        {icon}
        {title}
      </h4>
      {children}
    </section>
  );
}

/** Placeholder for an empty pullout section. Shows muted "nothing here yet"
 *  text, plus (for editors) a one-line `/command` setup hint so a room owner
 *  knows how to fill it in. */
function Empty({ text, hint }: { text: string; hint: string | null }) {
  return (
    <p className="text-xs italic leading-snug text-keep-muted/70">
      {text}
      {hint ? (
        <span className="mt-0.5 block not-italic text-keep-action/90">{hint}</span>
      ) : null}
    </p>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-keep-muted">{label}</dt>
      <dd className="truncate text-keep-text/90">{value}</dd>
    </>
  );
}

/**
 * The room's link handle, shown as the ready-to-paste `{room:<slug>}`
 * navigation-chip token with a one-click copy. Dropping that token into
 * chat, a forum post, a DM, or an announcement renders a chip that takes
 * people straight here. (Owners/mods can rename the handle with `/slug`.)
 */
function LinkRow({ slug }: { slug: string }) {
  const { copied, copy: copyToClipboard } = useCopyToClipboard({ resetMs: 1200 });
  const token = `{room:${slug}}`;
  const copy = () => {
    /* clipboard blocked (insecure context / denied) — no-op */
    void copyToClipboard(token);
  };
  return (
    <>
      <dt className="text-keep-muted">Link</dt>
      <dd className="truncate">
        <button
          type="button"
          onClick={copy}
          title="Copy the chat shortcut that links to this room"
          aria-label={`Copy ${token}`}
          className="inline-flex max-w-full items-center gap-1 text-keep-action hover:text-keep-action/80"
        >
          <span className="truncate font-mono text-[11px]">{token}</span>
          {copied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
        </button>
      </dd>
    </>
  );
}

/**
 * One row in the pinned-messages strip. Renders the frozen snapshot (author +
 * body) with the same color / cmd-CSS pass the chat line + bookmark rows use,
 * so a pinned styled command reads as the user remembers. Clicking the body
 * jumps to the live message (unless its source was hard-deleted — `messageId`
 * null — in which case the saved snapshot renders inert). Privileged viewers
 * get an Unpin button.
 */
function PinRow({
  pin,
  canUnpin,
  onJump,
  onUnpin,
}: {
  pin: PinnedMessage;
  canUnpin: boolean;
  onJump?: (messageId: string) => void;
  /** Arg is the live source message id, or the pin row id when the source was
   *  hard-deleted (see the Props doc). */
  onUnpin?: (idForUnpin: string) => void;
}) {
  const themeBg = useActiveTheme().bg;
  const color = resolveMessageColor(pin.color, themeBg);
  const cmdStyle = pin.kind === "cmd" ? customCmdCssToStyle(pin.cmdCss ?? null, themeBg) : null;
  const bodyStyle = {
    ...(color ? { color } : {}),
    ...(cmdStyle ?? {}),
  };
  // messageId goes null once the source message was hard-deleted; the snapshot
  // still renders but there's nothing live to jump to.
  const jumpable = !!pin.messageId && !!onJump;
  const body = pin.body ?? "";

  return (
    <li className="group flex items-start gap-2 px-3 py-1.5 text-sm hover:bg-keep-banner/30">
      <Pin size={12} aria-hidden className="mt-1 shrink-0 text-keep-action/70" />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-widest text-keep-muted">
          <b className="text-keep-text">{pin.displayName ?? "Someone"}</b>
          {pin.pinnedByDisplayName ? (
            <>
              <span className="mx-1">·</span>
              <span className="italic">pinned by {pin.pinnedByDisplayName}</span>
            </>
          ) : null}
        </div>
        {jumpable ? (
          <button
            type="button"
            onClick={() => onJump!(pin.messageId!)}
            className="mt-0.5 block w-full text-left text-sm leading-snug hover:underline"
            title="Jump to this message"
          >
            <span className="break-words" style={bodyStyle}>{parseInline(body)}</span>
          </button>
        ) : (
          <div
            className="mt-0.5 block w-full text-left text-sm leading-snug"
            title="The original message is gone; showing the pinned copy."
          >
            <span className="break-words" style={bodyStyle}>{parseInline(body)}</span>
          </div>
        )}
      </div>
      {canUnpin && onUnpin ? (
        // Always offered to privileged viewers — even when the source message
        // was hard-deleted (`messageId` null). We unpin by the live source id
        // when it survives (the existing message-id contract), otherwise by the
        // stable pin row id, which the server resolves too. Gating this on
        // `messageId` was the bug that left a hard-deleted pin un-unpinnable and
        // permanently consuming a pin-cap slot.
        <button
          type="button"
          onClick={() => onUnpin(pin.messageId ?? pin.id)}
          title="Unpin this message"
          aria-label="Unpin this message"
          className="mt-0.5 shrink-0 rounded border border-keep-rule/60 bg-keep-bg/60 p-1 text-keep-muted opacity-0 hover:border-keep-accent hover:text-keep-accent group-hover:opacity-100"
        >
          <PinOff size={12} aria-hidden />
        </button>
      ) : null}
    </li>
  );
}
