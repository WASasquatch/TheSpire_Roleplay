import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useChat } from "../state/store.js";
import { SearchBar } from "./SearchBar.js";

interface Props {
  onCommand: (text: string) => void;
  /** When set, the rail shows a "Leave Character" button to drop back to OOC. */
  activeCharacterId?: string | null;
  /** Current room; the search bar scopes to it. Null disables the bar. */
  currentRoomId: string | null;
  /** Jump to a specific message id in the given room. Search bar wires this. */
  onJumpToMessage: (roomId: string, messageId: string) => void;
}

/**
 * Bottom of the right rail. Composes:
 *   - Always-visible trigger bar with the most-clicked actions.
 *   - "More tools" drawer that slides up over the rail (rooms list hides
 *     behind it). The drawer holds buttons + inline forms for less-frequent
 *     commands, including ones that would otherwise require remembering the
 *     slash syntax (worlds, mood, scene, find, etc.).
 *
 * Mobile lives inside the existing rooms drawer (RoomsTree at sub-md widths
 * is a fixed-position slide-out), so the drawer here just expands upward
 * within that container - works the same as desktop.
 */
export function ToolPanel({ onCommand, activeCharacterId, currentRoomId, onJumpToMessage }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [moodOpen, setMoodOpen] = useState(false);
  const [sceneOpen, setSceneOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [privateOpen, setPrivateOpen] = useState(false);
  const fontStep = useChat((s) => s.fontStep);
  const setFontStep = useChat((s) => s.setFontStep);
  const refreshIntervalSec = useChat((s) => s.refreshIntervalSec);

  function cycleFont() {
    setFontStep(((fontStep + 1) % 4) as 0 | 1 | 2 | 3);
  }

  // Run a slash command and collapse the drawer + any open inline picker.
  // Used by the simple no-args buttons; the inline forms manage their own
  // close state so the user can submit and stay in context if they like.
  function fire(cmd: string) {
    onCommand(cmd);
    setDrawerOpen(false);
    setColorOpen(false);
    setRefreshOpen(false);
    setMoodOpen(false);
    setSceneOpen(false);
    setFindOpen(false);
    setPrivateOpen(false);
  }

  // Esc closes the drawer when it's open. Registering only while open keeps
  // global key behavior unchanged when the drawer is dismissed.
  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setDrawerOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <div className="relative shrink-0 border-t border-keep-rule bg-keep-banner/60 px-2 py-2">
      {drawerOpen ? (
        <>
          {/* Backdrop. Fixed-viewport so a click anywhere outside closes the
              drawer, including the chat area. Slightly tinted on desktop;
              tinted heavier on mobile (where the rail is itself a drawer
              and the backdrop is the only visual separation). */}
          <button
            type="button"
            aria-label="Close tools"
            onClick={() => setDrawerOpen(false)}
            className="fixed inset-0 z-30 bg-black/20 md:bg-black/10"
          />
          {/* Drawer body. Anchored to the trigger bar's top edge and grows
              upward; max-h is sized to fit inside the rail's available
              space (~14rem reserved for the chat banner + room-topic
              strip + a small safety margin). Without this cap the
              drawer can extend ABOVE the rail and get clipped by the
              parent's overflow-hidden — at which point its sticky
              header sits in the clipped region and the user sees the
              top section title disappear behind the chat banner.
              The internal overflow-y-auto handles any overflow from
              tools sections themselves. */}
          <div className="absolute inset-x-0 bottom-full z-40 max-h-[calc(100dvh-14rem)] overflow-y-auto rounded-t border-x border-t border-keep-rule bg-keep-bg shadow-2xl">
            <header className="sticky top-0 flex items-center justify-between border-b border-keep-rule bg-keep-banner px-3 py-2">
              <span className="text-xs font-action uppercase tracking-widest">Tools</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="text-xs text-keep-muted hover:text-keep-text"
              >
                close
              </button>
            </header>

            <Section title="Worldbuilding">
              <DrawerBtn label="My Worlds" hint="Manage your worlds + pages (/worlds)" onClick={() => fire("/worlds")} />
              <DrawerBtn label="World Catalog" hint="Browse open worlds (/world catalog)" onClick={() => fire("/world catalog")} />
            </Section>

            <Section title="Roleplay">
              <DrawerBtn
                label="Set Mood"
                hint="Show a mood next to your name (/mood)"
                onClick={() => setMoodOpen((v) => !v)}
                active={moodOpen}
              />
              {moodOpen ? (
                <InlineForm
                  placeholder="e.g. brooding, exhausted, smug"
                  submitLabel="Set"
                  extraButtons={[{ label: "Clear", onClick: () => fire("/mood clear") }]}
                  onSubmit={(text) => { if (text.trim()) fire(`/mood ${text.trim()}`); }}
                />
              ) : null}

              <DrawerBtn
                label="Set Scene"
                hint="Set the room's scene title (/scene)"
                onClick={() => setSceneOpen((v) => !v)}
                active={sceneOpen}
              />
              {sceneOpen ? (
                <InlineForm
                  placeholder="e.g. The dragon's lair"
                  submitLabel="Set"
                  extraButtons={[{ label: "End scene", onClick: () => fire("/scene end") }]}
                  onSubmit={(text) => { if (text.trim()) fire(`/scene ${text.trim()}`); }}
                />
              ) : null}

              <Row>
                <DrawerBtn label="NPCs On" hint="Enable NPC voice (/npcmode on)" onClick={() => fire("/npcmode on")} />
                <DrawerBtn label="NPCs Off" hint="Disable NPC voice (/npcmode off)" onClick={() => fire("/npcmode off")} />
              </Row>
            </Section>

            <Section title="Rooms">
              <DrawerBtn
                label="Find Rooms"
                hint="Search for a room by name (/find)"
                onClick={() => setFindOpen((v) => !v)}
                active={findOpen}
              />
              {findOpen ? (
                <InlineForm
                  placeholder="search text (or empty for all)"
                  submitLabel="Find"
                  onSubmit={(text) => fire(text.trim() ? `/find ${text.trim()}` : "/find")}
                />
              ) : null}

              <DrawerBtn label="List Rooms" hint="Show all public rooms (/list)" onClick={() => fire("/list")} />

              <DrawerBtn
                label="New Private Room"
                hint="Create a password-locked room (/private)"
                onClick={() => setPrivateOpen((v) => !v)}
                active={privateOpen}
              />
              {privateOpen ? (
                <PrivateForm onSubmit={(name, pw) => fire(`/private ${name} ${pw}`)} />
              ) : null}
            </Section>

            <Section title="People">
              <DrawerBtn label="Watching" hint="Who you've /watch'd (/watching)" onClick={() => fire("/watching")} />
              <DrawerBtn label="All Users" hint="Browse the user directory (/users)" onClick={() => fire("/users")} />
              <DrawerBtn label="Ignore List" hint="Show or clear your ignore list (/ignore)" onClick={() => fire("/ignore")} />
            </Section>

            <Section title="Display">
              <DrawerBtn
                label="Color"
                hint="Set your chat color (/color)"
                onClick={() => setColorOpen((v) => !v)}
                active={colorOpen}
              />
              {colorOpen ? (
                <ColorPicker
                  onPick={(hex) => fire(`/color ${hex}`)}
                  onClear={() => fire("/color clear")}
                />
              ) : null}

              <DrawerBtn label={`Font size: ${fontStep}`} hint="Cycle local chat font size" onClick={cycleFont} />

              <DrawerBtn
                label={refreshIntervalSec > 0 ? `Refresh: ${refreshIntervalSec}s` : "Refresh"}
                hint={refreshIntervalSec > 0 ? `Auto-refresh every ${refreshIntervalSec}s` : "Refresh once or schedule (/refresh)"}
                onClick={() => setRefreshOpen((v) => !v)}
                active={refreshOpen || refreshIntervalSec > 0}
              />
              {refreshOpen ? (
                <RefreshPicker
                  current={refreshIntervalSec}
                  onPick={(n) => {
                    if (n === 0) fire("/refresh off");
                    else if (n === -1) fire("/refresh");
                    else fire(`/refresh ${n}`);
                  }}
                />
              ) : null}
            </Section>

            <Section title="Account">
              <DrawerBtn label="Edit Profile" hint="Open your profile editor (/profile)" onClick={() => fire("/profile")} />
              <DrawerBtn label="Bookmarks" hint="Your saved chat messages (/bookmarks)" onClick={() => fire("/bookmarks")} />
              <DrawerBtn label="Toggle Away" hint="Mark yourself away (/away)" onClick={() => fire("/away")} />
              <DrawerBtn label="Help / Commands" hint="Browse all commands (/help)" onClick={() => fire("/help")} />
            </Section>

            {/* Search lives at the bottom of the drawer so the input is
                close to the user's resting touch position on mobile.
                Results render upward (most-relevant nearest the bar) — see
                SearchBar for the spatial-proximity-to-action rationale. */}
            <Section title="Search this room">
              <SearchBar
                roomId={currentRoomId}
                onJump={(messageId) => {
                  if (currentRoomId) onJumpToMessage(currentRoomId, messageId);
                }}
                onClose={() => setDrawerOpen(false)}
              />
            </Section>
          </div>
        </>
      ) : null}

      {/* Trigger bar - always visible at the bottom of the rail. */}
      <button
        type="button"
        onClick={() => setDrawerOpen((v) => !v)}
        title="Open the tools drawer"
        // py-2.5 on mobile (thumb target); py-1 on md+ for compact desktop.
        className={`flex w-full items-center justify-center gap-2 rounded border border-keep-rule py-2.5 text-xs font-semibold uppercase tracking-widest md:py-1 ${
          drawerOpen ? "bg-keep-banner" : "bg-keep-bg hover:bg-keep-banner"
        }`}
      >
        <span aria-hidden>{drawerOpen ? "▼" : "▲"}</span>
        Tools
      </button>

      {activeCharacterId ? (
        <button
          type="button"
          onClick={() => fire("/char clear")}
          title="Drop the active character and return to your master (OOC) account."
          className="mt-1 w-full rounded border border-keep-border bg-keep-accent/10 py-2 text-xs font-semibold text-keep-accent hover:bg-keep-accent/20 md:py-1"
        >
          ← Leave Character (OOC)
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ *
 *  Drawer building blocks
 * ------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-keep-rule/60 p-2">
      <div className="mb-1 px-1 text-[10px] uppercase tracking-widest text-keep-muted">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex gap-1">{children}</div>;
}

function DrawerBtn({
  label,
  hint,
  onClick,
  active,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      // py-2 baseline keeps mobile thumb targets generous; flex-1 lets Row
      // pack two side-by-side equally.
      className={`flex-1 rounded border border-keep-rule px-2 py-2 text-left text-xs md:py-1 ${
        active ? "bg-keep-banner" : "bg-keep-bg hover:bg-keep-banner"
      }`}
    >
      {label}
    </button>
  );
}

function InlineForm({
  placeholder,
  submitLabel,
  onSubmit,
  extraButtons,
}: {
  placeholder: string;
  submitLabel: string;
  onSubmit: (text: string) => void;
  extraButtons?: Array<{ label: string; onClick: () => void }>;
}) {
  const [text, setText] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(text);
    setText("");
  }
  return (
    <form onSubmit={submit} className="space-y-1 rounded border border-keep-rule/60 bg-keep-banner/30 p-2">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-xs outline-none focus:border-keep-action md:py-1"
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
      />
      <div className="flex gap-1">
        <button
          type="submit"
          className="keep-button flex-1 rounded border border-keep-rule bg-keep-banner px-2 py-1.5 text-xs hover:bg-keep-banner/80 md:py-1"
        >
          {submitLabel}
        </button>
        {extraButtons?.map((b) => (
          <button
            key={b.label}
            type="button"
            onClick={b.onClick}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-xs hover:bg-keep-banner md:py-1"
          >
            {b.label}
          </button>
        ))}
      </div>
    </form>
  );
}

function PrivateForm({ onSubmit }: { onSubmit: (name: string, password: string) => void }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !password.trim()) return;
    onSubmit(name.trim(), password.trim());
    setName("");
    setPassword("");
  }
  return (
    <form onSubmit={submit} className="space-y-1 rounded border border-keep-rule/60 bg-keep-banner/30 p-2">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="room name"
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-xs outline-none focus:border-keep-action md:py-1"
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
      />
      <input
        type="text"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="password"
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-xs outline-none focus:border-keep-action md:py-1"
      />
      <button
        type="submit"
        disabled={!name.trim() || !password.trim()}
        className="keep-button w-full rounded border border-keep-rule bg-keep-banner px-2 py-1.5 text-xs hover:bg-keep-banner/80 disabled:opacity-50 md:py-1"
      >
        Create room
      </button>
    </form>
  );
}

const PRESETS = [
  "#990000", "#cc6600", "#cc9900", "#669933",
  "#006699", "#003366", "#663399", "#660033",
  "#333333", "#666666",
];

const REFRESH_PRESETS: Array<{ label: string; value: number }> = [
  { label: "Now (one-shot)", value: -1 },
  { label: "Every 10s", value: 10 },
  { label: "Every 30s", value: 30 },
  { label: "Every 60s", value: 60 },
  { label: "Every 5m", value: 300 },
];

function RefreshPicker({ current, onPick }: { current: number; onPick: (n: number) => void }) {
  const [custom, setCustom] = useState("");
  return (
    <div className="rounded border border-keep-rule/60 bg-keep-banner/30 p-2 text-xs">
      {current > 0 ? (
        <div className="mb-1 text-keep-muted">currently every {current}s</div>
      ) : null}
      <ul className="mb-1 space-y-0.5">
        {REFRESH_PRESETS.map((p) => (
          <li key={p.label}>
            <button
              type="button"
              onClick={() => onPick(p.value)}
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-left hover:bg-keep-banner md:py-1"
            >
              {p.label}
            </button>
          </li>
        ))}
      </ul>
      <div className="mb-1 flex items-center gap-1">
        <input
          type="number"
          min={5}
          max={3600}
          step={1}
          placeholder="seconds"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          className="flex-1 rounded border border-keep-rule px-2 py-1.5 md:py-1"
        />
        <button
          type="button"
          onClick={() => {
            const n = parseInt(custom, 10);
            if (Number.isFinite(n) && n >= 5 && n <= 3600) onPick(n);
          }}
          className="rounded border border-keep-rule bg-keep-banner px-2 py-1.5 hover:bg-keep-banner/80 md:py-1"
        >
          Set
        </button>
      </div>
      <button
        type="button"
        onClick={() => onPick(0)}
        className="w-full rounded border border-keep-rule bg-keep-bg py-1.5 hover:bg-keep-banner md:py-1"
      >
        Off
      </button>
    </div>
  );
}

function ColorPicker({ onPick, onClear }: { onPick: (hex: string) => void; onClear: () => void }) {
  const [custom, setCustom] = useState("#990000");
  return (
    <div className="rounded border border-keep-rule/60 bg-keep-banner/30 p-2 text-xs">
      <div className="mb-1 grid grid-cols-5 gap-1">
        {PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onPick(c)}
            className="h-7 w-full rounded border border-keep-rule md:h-5"
            style={{ backgroundColor: c }}
            aria-label={c}
            title={c}
          />
        ))}
      </div>
      <div className="flex items-center gap-1">
        <input
          type="color"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          className="h-8 w-10 cursor-pointer border border-keep-rule md:h-6 md:w-8"
        />
        <input
          type="text"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          className="flex-1 rounded border border-keep-rule px-2 py-1.5 font-mono md:py-1"
          maxLength={7}
        />
        <button
          type="button"
          onClick={() => onPick(custom)}
          className="rounded border border-keep-rule bg-keep-banner px-2 py-1.5 hover:bg-keep-banner/80 md:py-1"
        >
          Set
        </button>
      </div>
      <button
        type="button"
        onClick={onClear}
        className="keep-button mt-1 w-full rounded border border-keep-rule bg-keep-bg py-1.5 hover:bg-keep-banner md:py-1"
      >
        Clear
      </button>
    </div>
  );
}
