/**
 * Free-form border template placeholder substitution.
 *
 * Templates are admin-authored HTML strings that wrap a user's
 * avatar in custom markup. The single placeholder is:
 *
 *   {avatar}   — the avatar `<img>` (or initials fallback) as an
 *                inline HTML fragment. Mirrors how nameStyleTemplate
 *                handles `{username}`.
 *
 * Example template:
 *
 *   <div class="av b-aurora-v2"><div class="pic">{avatar}</div></div>
 *
 * Together with the style_css (scoped under `.b-aurora-v2`) this
 * produces the ornate border around the avatar. Multi-element
 * decorations live inside the same template (e.g. `<span class="leaf
 * lf1"></span>` siblings), which is why the template can't be
 * synthesized client-side from the key alone.
 *
 * The caller is responsible for the DOMPurify sanitization pass on
 * the merged output. Admin trust + CSP layer defense-in-depth.
 */

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render the avatar fragment that `{avatar}` expands to. When the
 * caller has a URL we produce an `<img>` with the same attributes
 * BorderedAvatar's React render would have used (rounded, lazy
 * load, no referrer leak). When the URL is missing (or has been
 * marked errored upstream), we fall back to an initials chip —
 * matches the React-rendered fallback so a missing avatar doesn't
 * leave the border empty.
 *
 * `cropStyleAttr` is an opaque `style="..."` attribute string
 * (built by `lib/avatarCrop.ts`) that carries the owner's
 * zoom/pan transform. The template's own picture container
 * already clips to the circle, so the zoom rides through the same
 * mask without needing an extra wrapper — preserves the freeform
 * border's outer decoration unchanged.
 */
export function buildAvatarFragment(opts: {
  avatarUrl: string | null | undefined;
  name: string;
  cropStyleAttr?: string;
}): string {
  if (opts.avatarUrl) {
    const url = escapeHtmlAttr(opts.avatarUrl);
    const crop = opts.cropStyleAttr ?? "";
    return `<img src="${url}" alt="" loading="lazy" referrerpolicy="no-referrer" class="h-full w-full rounded-full object-cover"${crop} />`;
  }
  const initials = escapeHtmlAttr(initialsFor(opts.name));
  return `<span class="flex h-full w-full items-center justify-center rounded-full">${initials}</span>`;
}

export function applyFreeformBorderPlaceholders(
  template: string,
  opts: { avatarUrl: string | null | undefined; name: string; cropStyleAttr?: string },
): string {
  const avatar = buildAvatarFragment(opts);
  return template.replace(/\{avatar\}/g, avatar);
}

function initialsFor(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
