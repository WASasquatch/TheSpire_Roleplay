/** Escape a literal keyword for safe embedding in a RegExp source. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
