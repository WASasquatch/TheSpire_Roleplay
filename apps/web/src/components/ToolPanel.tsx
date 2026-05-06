import { useState } from "react";
import { useChat } from "../state/store.js";

interface Props {
  onCommand: (text: string) => void;
  /** When set, the rail shows a "Leave Character" button to drop back to OOC. */
  activeCharacterId?: string | null;
}

/**
 * Right-rail tool buttons.
 *
 * Each button maps to a slash command run on the server (Refresh, Color, Help)
 * or a local UI preference (Size). Color opens an inline hex picker so users
 * don't have to type the command, but it submits via /color so the server
 * remains the single source of truth.
 */
export function ToolPanel({ onCommand, activeCharacterId }: Props) {
  const [colorOpen, setColorOpen] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const fontStep = useChat((s) => s.fontStep);
  const setFontStep = useChat((s) => s.setFontStep);
  const refreshIntervalSec = useChat((s) => s.refreshIntervalSec);

  function cycleFont() {
    setFontStep(((fontStep + 1) % 4) as 0 | 1 | 2 | 3);
  }

  return (
    <div className="border-t border-keep-rule bg-keep-banner/60 px-2 py-2">
      <div className="mb-1 text-xs uppercase tracking-widest text-keep-muted">Tools</div>
      <div className="grid grid-cols-2 gap-1 text-xs">
        <ToolBtn
          label={refreshIntervalSec > 0 ? `Refresh ${refreshIntervalSec}s` : "Refresh"}
          title={
            refreshIntervalSec > 0
              ? `Auto-refresh every ${refreshIntervalSec}s — click for menu`
              : "Re-fetch userlist + topic (/refresh)"
          }
          onClick={() => setRefreshOpen((v) => !v)}
          active={refreshOpen || refreshIntervalSec > 0}
        />
        <ToolBtn label="Color" title="Set your chat color" onClick={() => setColorOpen((v) => !v)} active={colorOpen} />
        <ToolBtn label={`Size ${fontStep}`} title="Cycle chat font size (local)" onClick={cycleFont} />
        <ToolBtn label="Help" title="Open command reference (/help)" onClick={() => onCommand("/help")} />
        <ToolBtn
          label="Profile"
          title="Edit your profile (/profile)"
          onClick={() => onCommand("/profile")}
        />
        <ToolBtn label="Away" title="Toggle away (/away)" onClick={() => onCommand("/away")} />
        <ToolBtn label="Users" title="Browse all registered users (/users)" onClick={() => onCommand("/users")} />
      </div>

      {activeCharacterId ? (
        <button
          type="button"
          onClick={() => onCommand("/char clear")}
          title="Drop the active character and return to your master (OOC) account."
          className="mt-1 w-full rounded border border-keep-border bg-keep-accent/10 py-1 text-xs font-semibold text-keep-accent hover:bg-keep-accent/20"
        >
          ← Leave Character (OOC)
        </button>
      ) : null}

      {refreshOpen ? (
        <RefreshPicker
          current={refreshIntervalSec}
          onPick={(n) => {
            if (n === 0) onCommand("/refresh off");
            else if (n === -1) onCommand("/refresh");
            else onCommand(`/refresh ${n}`);
            setRefreshOpen(false);
          }}
        />
      ) : null}

      {colorOpen ? (
        <ColorPicker
          onPick={(hex) => {
            onCommand(`/color ${hex}`);
            setColorOpen(false);
          }}
          onClear={() => {
            onCommand("/color clear");
            setColorOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function ToolBtn({
  label,
  title,
  onClick,
  active,
}: {
  label: string;
  title: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      // py-2 on mobile for thumb-friendly target, py-0.5 on md+ to keep
      // desktop density compact.
      className={`rounded border border-keep-rule py-2 md:py-0.5 ${
        active ? "bg-keep-banner" : "bg-keep-bg hover:bg-keep-banner"
      }`}
    >
      {label}
    </button>
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
    <div className="mt-2 rounded border border-keep-rule bg-keep-bg p-2 text-xs">
      <div className="mb-1 font-semibold">Auto-refresh</div>
      {current > 0 ? (
        <div className="mb-1 text-keep-muted">currently every {current}s</div>
      ) : null}
      <ul className="mb-1 space-y-0.5">
        {REFRESH_PRESETS.map((p) => (
          <li key={p.label}>
            <button
              type="button"
              onClick={() => onPick(p.value)}
              className="w-full rounded border border-keep-rule bg-keep-bg px-1 py-0.5 text-left hover:bg-keep-banner"
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
          className="flex-1 rounded border border-keep-rule px-1 py-0.5"
        />
        <button
          type="button"
          onClick={() => {
            const n = parseInt(custom, 10);
            if (Number.isFinite(n) && n >= 5 && n <= 3600) onPick(n);
          }}
          className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80"
        >
          Set
        </button>
      </div>
      <button
        type="button"
        onClick={() => onPick(0)}
        className="w-full rounded border border-keep-rule bg-keep-bg py-0.5 hover:bg-keep-banner"
      >
        Off
      </button>
    </div>
  );
}

function ColorPicker({ onPick, onClear }: { onPick: (hex: string) => void; onClear: () => void }) {
  const [custom, setCustom] = useState("#990000");
  return (
    <div className="mt-2 rounded border border-keep-rule bg-keep-bg p-2 text-xs">
      <div className="mb-1 grid grid-cols-5 gap-1">
        {PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onPick(c)}
            className="h-5 w-full rounded border border-keep-rule"
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
          className="h-6 w-8 cursor-pointer border border-keep-rule"
        />
        <input
          type="text"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          className="flex-1 rounded border border-keep-rule px-1 py-0.5 font-mono"
          maxLength={7}
        />
        <button
          type="button"
          onClick={() => onPick(custom)}
          className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80"
        >
          Set
        </button>
      </div>
      <button
        type="button"
        onClick={onClear}
        className="mt-1 w-full rounded border border-keep-rule bg-keep-bg py-0.5 hover:bg-keep-banner"
      >
        Clear
      </button>
    </div>
  );
}
