import type { Theme } from "@thekeep/shared";
import { DEFAULT_THEME, THEME_PRESETS } from "@thekeep/shared";

interface Props {
  theme: Theme;
  onChange: (theme: Theme) => void;
  onReset: () => void;
}

const SLOTS: Array<{ key: keyof Theme; label: string; hint: string }> = [
  { key: "bg",     label: "Background", hint: "Main chat backdrop" },
  { key: "panel",  label: "Panel",      hint: "Banner, side rails, modal headers" },
  { key: "border", label: "Border",     hint: "Rule lines and frame edges" },
  { key: "text",   label: "Text",       hint: "Primary readable text" },
  { key: "muted",  label: "Muted",      hint: "Timestamps, hints, secondary text" },
  { key: "action", label: "Action",     hint: "Highlights, current room, links" },
  { key: "accent", label: "Accent",     hint: "Strong call-to-action / Exit button" },
  { key: "system", label: "System",     hint: "Italic system messages" },
];

/**
 * Live theme picker. Presets load all 8 colors at once; individual sliders
 * tweak from there. The miniature preview shows the theme applied to a
 * mock chat row so the user sees the result without leaving the editor.
 */
export function ThemePicker({ theme, onChange, onReset }: Props) {
  function setSlot(slot: keyof Theme, hex: string) {
    onChange({ ...theme, [slot]: hex });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {THEME_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => onChange(p.theme)}
            title={`Apply preset: ${p.name}`}
            // Each chip renders in its OWN theme so users see what they're
            // about to apply at a glance.
            style={{
              backgroundColor: p.theme.bg,
              color: p.theme.text,
              borderColor: p.theme.border,
            }}
            className="flex items-center gap-1 rounded border px-2 py-1 text-xs hover:opacity-90"
          >
            <span className="flex">
              {(["panel", "action", "accent"] as const).map((k) => (
                <span
                  key={k}
                  className="inline-block h-3 w-3"
                  style={{ backgroundColor: p.theme[k], border: `1px solid ${p.theme.border}` }}
                />
              ))}
            </span>
            {p.name}
          </button>
        ))}
        <button
          type="button"
          onClick={onReset}
          title="Revert to system default"
          className="keep-button ml-auto rounded border border-keep-border bg-keep-bg px-2 py-1 text-xs text-keep-muted hover:text-keep-text"
        >
          Default
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {SLOTS.map(({ key, label, hint }) => (
          <label key={key} className="flex items-center gap-2 text-xs">
            <input
              type="color"
              value={theme[key]}
              onChange={(e) => setSlot(key, e.target.value)}
              className="h-6 w-8 cursor-pointer border border-keep-border"
              aria-label={label}
            />
            <span className="flex-1">
              <span className="block uppercase tracking-widest text-keep-muted">{label}</span>
              <span className="block text-[10px] text-keep-muted">{hint}</span>
            </span>
            <input
              type="text"
              value={theme[key]}
              onChange={(e) => setSlot(key, e.target.value)}
              className="w-20 rounded border border-keep-border bg-keep-bg px-1 py-0.5 font-mono text-[11px]"
              maxLength={7}
            />
          </label>
        ))}
      </div>

      {/* Live preview - applies the theme to a mock chat snippet. */}
      <ThemePreview theme={theme} />
    </div>
  );
}

function ThemePreview({ theme }: { theme: Theme }) {
  // Every color is set inline so the preview can't accidentally pick up the
  // editor's CSS vars and lie about what the theme will look like.
  return (
    <div
      style={{
        backgroundColor: theme.bg,
        color: theme.text,
        borderColor: theme.border,
      }}
      className="rounded border p-2 text-xs"
    >
      <div
        className="-mx-2 -mt-2 mb-1 px-2 py-1"
        style={{
          backgroundColor: theme.panel,
          borderBottom: `1px solid ${theme.border}`,
        }}
      >
        <span className="font-action text-sm" style={{ color: theme.text }}>The Spire</span>{" "}
        <span style={{ color: theme.muted }}>· preview</span>
      </div>
      <div>
        <span style={{ color: theme.muted }}>14:30:00 </span>
        [<span className="font-semibold" style={{ color: theme.text }}>Sigrid</span>]{" "}
        <span style={{ color: theme.text }}>hello there.</span>
      </div>
      <div className="font-action" style={{ color: theme.action }}>
        14:30:01 <span className="font-semibold">Sigrid</span> draws her sword.
      </div>
      <div style={{ color: theme.system }} className="italic">
        14:30:02 * Topic set: Welcome to The Spire.
      </div>
      <div style={{ color: theme.accent }} className="font-bold">
        14:30:03 📣 Announcement!
      </div>
    </div>
  );
}

export { DEFAULT_THEME };
