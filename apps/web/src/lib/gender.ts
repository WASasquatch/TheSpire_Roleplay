import { i18n } from "./i18n.js";

export type Gender = "male" | "female" | "nonbinary" | "other" | "undisclosed";

/** Single character icon for each gender. Tooltip carries the long name. */
export function genderGlyph(g: Gender): { icon: string; title: string; color: string } {
  switch (g) {
    case "male":        return { icon: "♂", title: i18n.t("common:gender.male"), color: "#3a6db8" };
    case "female":      return { icon: "♀", title: i18n.t("common:gender.female"), color: "#b8467a" };
    case "nonbinary":   return { icon: "⚧", title: i18n.t("common:gender.nonbinary"), color: "#7a4ab8" };
    case "other":       return { icon: "◆", title: i18n.t("common:gender.other"), color: "#7a7a7a" };
    case "undisclosed":
    default:            return { icon: "◯", title: i18n.t("common:gender.undisclosed"), color: "#9a9a9a" };
  }
}

/**
 * Labels resolve through i18n at PROPERTY-ACCESS time (getters), so the
 * exported constant keeps its shape for existing consumers while a live
 * language switch still re-resolves on the next render.
 */
export const GENDER_OPTIONS: Array<{ value: Gender; label: string }> = [
  { value: "undisclosed", get label() { return i18n.t("common:gender.options.undisclosed"); } },
  { value: "male", get label() { return i18n.t("common:gender.options.male"); } },
  { value: "female", get label() { return i18n.t("common:gender.options.female"); } },
  { value: "nonbinary", get label() { return i18n.t("common:gender.options.nonbinary"); } },
  { value: "other", get label() { return i18n.t("common:gender.options.other"); } },
];
