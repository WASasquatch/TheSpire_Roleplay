import { Trans, useTranslation } from "react-i18next";
import type { Theme } from "@thekeep/shared";
import { DEFAULT_THEME, THEME_PRESETS } from "@thekeep/shared";

interface Props {
  theme: Theme;
  onChange: (theme: Theme) => void;
  onReset: () => void;
}

// Labels/hints resolve through t() at render time (not module scope) so a
// live language switch re-renders the slot grid in the new language.
const SLOTS: Array<{ key: keyof Theme; labelKey: string; hintKey: string }> = [
  { key: "bg",     labelKey: "themePicker.slots.bg.label",     hintKey: "themePicker.slots.bg.hint" },
  { key: "panel",  labelKey: "themePicker.slots.panel.label",  hintKey: "themePicker.slots.panel.hint" },
  { key: "border", labelKey: "themePicker.slots.border.label", hintKey: "themePicker.slots.border.hint" },
  { key: "text",   labelKey: "themePicker.slots.text.label",   hintKey: "themePicker.slots.text.hint" },
  { key: "muted",  labelKey: "themePicker.slots.muted.label",  hintKey: "themePicker.slots.muted.hint" },
  { key: "action", labelKey: "themePicker.slots.action.label", hintKey: "themePicker.slots.action.hint" },
  { key: "accent", labelKey: "themePicker.slots.accent.label", hintKey: "themePicker.slots.accent.hint" },
  { key: "system", labelKey: "themePicker.slots.system.label", hintKey: "themePicker.slots.system.hint" },
];

/**
 * Live theme picker. Presets load all 8 colors at once; individual sliders
 * tweak from there. The miniature preview shows the theme applied to a
 * mock chat row so the user sees the result without leaving the editor.
 */
export function ThemePicker({ theme, onChange, onReset }: Props) {
  const { t } = useTranslation("common");
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
            title={t("themePicker.applyPreset", { name: p.name })}
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
          title={t("themePicker.revertTitle")}
          className="keep-button ml-auto rounded border border-keep-border bg-keep-bg px-2 py-1 text-xs text-keep-muted hover:text-keep-text"
        >
          {t("default")}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {SLOTS.map(({ key, labelKey, hintKey }) => (
          <label key={key} className="flex items-center gap-2 text-xs">
            <input
              type="color"
              value={theme[key]}
              onChange={(e) => setSlot(key, e.target.value)}
              className="h-6 w-8 cursor-pointer border border-keep-border"
              aria-label={t(labelKey)}
            />
            <span className="flex-1">
              <span className="block uppercase tracking-widest text-keep-muted">{t(labelKey)}</span>
              <span className="block text-[10px] text-keep-muted">{t(hintKey)}</span>
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
  const { t } = useTranslation("common");
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
        <span className="font-action text-sm" style={{ color: theme.text }}>{t("appName")}</span>{" "}
        <span style={{ color: theme.muted }}>{t("themePicker.preview.caption")}</span>
      </div>
      <div>
        <span style={{ color: theme.muted }}>14:30:00 </span>
        [<span className="font-semibold" style={{ color: theme.text }}>{t("themePicker.preview.sampleName")}</span>]{" "}
        <span style={{ color: theme.text }}>{t("themePicker.preview.sampleMessage")}</span>
      </div>
      <div className="font-action" style={{ color: theme.action }}>
        14:30:01{" "}
        <Trans t={t} i18nKey="themePicker.preview.actionLine">
          <span className="font-semibold">Sigrid</span> draws her sword.
        </Trans>
      </div>
      <div style={{ color: theme.system }} className="italic">
        14:30:02 {t("themePicker.preview.sampleSystem")}
      </div>
      <div style={{ color: theme.accent }} className="font-bold">
        14:30:03 {t("themePicker.preview.sampleAnnouncement")}
      </div>
    </div>
  );
}

export { DEFAULT_THEME };
