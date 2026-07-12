/**
 * Usergroup ("role") badge chips — the profile hero's "Roles" row, built to
 * be reused anywhere a compact role list is needed (the userlist gets a
 * twin later). Chip chrome copies LanguageTagChips (border-keep-rule +
 * bg-keep-bg/60) so the row reads as the same family; the group's
 * owner-picked color tints a leading dot + the chip border ONLY — never a
 * username (purchasable cosmetics stay the sole source of name styling).
 */

import { useTranslation } from "react-i18next";
import { Tag } from "lucide-react";
import type { ServerRoleBadge } from "@thekeep/shared";

/**
 * Clamp an owner-supplied color string to safe CSS color forms before it
 * lands in a style prop: hex, bare keyword, or rgb()/hsl() function with a
 * numeric-ish body. The column is free text (max 32 chars, no server-side
 * format check), so anything else renders with the default ink.
 */
export function safeCssColor(raw: string | null | undefined): string | null {
  const c = raw?.trim() ?? "";
  if (!c || c.length > 32) return null;
  if (/^#[0-9a-fA-F]{3,8}$/.test(c)) return c;
  if (/^[a-zA-Z]{3,20}$/.test(c)) return c;
  if (/^(?:rgb|rgba|hsl|hsla)\([\d\s.,%/-]+\)$/.test(c)) return c;
  return null;
}

export function RoleBadgeChips({ roles, ariaLabel, compact = false }: {
  roles: ServerRoleBadge[];
  /** Row meaning for screen readers + the leading glyph's tooltip. */
  ariaLabel: string;
  /** Drops the leading "roles" glyph for tight single-chip surfaces (the
   *  userlist row); each chip's own title still carries the meaning. */
  compact?: boolean;
}) {
  const { t } = useTranslation("profile");
  if (roles.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1" role="list" aria-label={ariaLabel}>
      {/* Leading glyph so the row reads as "community roles" at a glance —
          decorative; the aria-label carries the meaning, the title covers
          sighted hover. Mirrors LanguageTagChips' Languages glyph. */}
      {compact ? null : (
        <span title={ariaLabel} className="text-keep-muted">
          <Tag className="h-3.5 w-3.5" aria-hidden />
        </span>
      )}
      {roles.map((r, i) => {
        const color = safeCssColor(r.color);
        return (
          <span
            key={`${r.name}-${i}`}
            role="listitem"
            title={t("modal.roles.chipTitle", { name: r.name })}
            className="inline-flex items-center gap-1.5 rounded border border-keep-rule bg-keep-bg/60 px-1.5 py-0.5 text-[11px] leading-none text-keep-text"
            style={color ? { borderColor: color } : undefined}
          >
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full bg-keep-muted/60"
              style={color ? { background: color } : undefined}
            />
            {/* Names run up to SERVER_USERGROUP_NAME_MAX (40 chars); cap the
                chip so it can't crush a flexed username or overflow narrow
                rails — the title above still carries the full name. */}
            <span className="max-w-[7rem] truncate">{r.name}</span>
          </span>
        );
      })}
    </div>
  );
}
