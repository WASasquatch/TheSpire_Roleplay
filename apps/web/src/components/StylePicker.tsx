import { useTranslation } from "react-i18next";
import { listStyles } from "../lib/ornaments/index.js";

/**
 * Shared style-key picker. Reads available styles from the ornaments
 * registry so the catalog stays single-sourced, adding a style file
 * automatically surfaces it here without UI changes.
 *
 * Caller controls value semantics:
 *  - Admin: required, defaults to "medieval"
 *  - Profile: nullable; null means "follow site default", represented
 *    by the empty-string sentinel in the <select>.
 */
export function StylePicker({
  value,
  onChange,
  allowInherit = false,
}: {
  value: string | null;
  onChange: (key: string | null) => void;
  /** When true, prepend a "(use site default)" option whose value is null. */
  allowInherit?: boolean;
}) {
  const { t } = useTranslation("common");
  const styles = listStyles();
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
    >
      {allowInherit ? (
        <option value="">{t("stylePicker.useSiteDefault")}</option>
      ) : null}
      {styles.map((s) => (
        <option key={s.key} value={s.key}>{s.label}</option>
      ))}
    </select>
  );
}
