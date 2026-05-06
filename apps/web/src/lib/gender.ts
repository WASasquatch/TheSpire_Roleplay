export type Gender = "male" | "female" | "nonbinary" | "other" | "undisclosed";

/** Single character icon for each gender. Tooltip carries the long name. */
export function genderGlyph(g: Gender): { icon: string; title: string; color: string } {
  switch (g) {
    case "male":        return { icon: "♂", title: "male", color: "#3a6db8" };
    case "female":      return { icon: "♀", title: "female", color: "#b8467a" };
    case "nonbinary":   return { icon: "⚧", title: "nonbinary", color: "#7a4ab8" };
    case "other":       return { icon: "◆", title: "other", color: "#7a7a7a" };
    case "undisclosed":
    default:            return { icon: "◯", title: "undisclosed", color: "#9a9a9a" };
  }
}

export const GENDER_OPTIONS: Array<{ value: Gender; label: string }> = [
  { value: "undisclosed", label: "Undisclosed" },
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "nonbinary", label: "Non-binary" },
  { value: "other", label: "Other" },
];
