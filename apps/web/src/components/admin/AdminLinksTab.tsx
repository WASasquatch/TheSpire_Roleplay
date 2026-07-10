import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { readError } from "../../lib/http.js";

/* =============================================================
 * NAV LINKS TAB
 * ============================================================= */

interface NavLinkRow {
  id: string;
  label: string;
  href: string;
  target: "_self" | "_blank";
  position: number;
  enabled: boolean;
}

interface NavLinkInput {
  label: string;
  href: string;
  position?: number;
  enabled?: boolean;
  target?: "_self" | "_blank";
}

export function LinksTab({ onLinksChanged }: { onLinksChanged: () => void }) {
  const { t } = useTranslation("admin");
  const [links, setLinks] = useState<NavLinkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch("/admin/nav-links", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { links: NavLinkRow[] };
      setLinks(j.links);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);

  async function create(input: NavLinkInput) {
    const r = await fetch("/admin/nav-links", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(await readError(r));
    onLinksChanged();
    await reload();
  }

  async function patch(id: string, input: Partial<NavLinkInput>) {
    const r = await fetch(`/admin/nav-links/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(await readError(r));
    onLinksChanged();
    await reload();
  }

  async function destroy(id: string) {
    if (!window.confirm(t("links.deleteConfirm"))) return;
    const r = await fetch(`/admin/nav-links/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!r.ok) throw new Error(await readError(r));
    onLinksChanged();
    await reload();
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-keep-muted">
        {t("links.description")}
      </p>

      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div> : null}

      <NewLinkForm onCreate={create} />

      {loading ? (
        <div className="text-keep-muted">{t("loading")}</div>
      ) : links.length === 0 ? (
        <div className="rounded border border-keep-rule bg-keep-bg p-4 text-center text-sm text-keep-muted">
          {t("links.empty")}
        </div>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[560px] text-xs">
          <thead className="bg-keep-banner/50 text-keep-muted uppercase tracking-widest">
            <tr>
              <th className="px-2 py-1 text-left">{t("links.colPos")}</th>
              <th className="px-2 py-1 text-left">{t("links.colLabel")}</th>
              <th className="px-2 py-1 text-left">{t("links.colUrl")}</th>
              <th className="px-2 py-1">{t("links.colTarget")}</th>
              <th className="px-2 py-1">{t("common:on")}</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <LinkRow key={l.id} link={l} onPatch={patch} onDelete={destroy} />
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

function NewLinkForm({ onCreate }: { onCreate: (i: NavLinkInput) => Promise<void> }) {
  const { t } = useTranslation("admin");
  const [label, setLabel] = useState("");
  const [href, setHref] = useState("");
  const [position, setPosition] = useState("0");
  const [target, setTarget] = useState<"_self" | "_blank">("_blank");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        label: label.trim(),
        href: href.trim(),
        position: parseInt(position, 10) || 0,
        target,
      });
      setLabel("");
      setHref("");
      setPosition("0");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("createFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form data-admin-anchor="links.addTitle" onSubmit={submit} className="rounded border border-keep-rule bg-keep-bg p-2 text-xs">
      <div className="mb-1 font-semibold">{t("links.addTitle")}</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-12">
        <input
          required
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("links.labelPlaceholder")}
          maxLength={40}
          className="col-span-2 rounded border border-keep-rule px-2 py-1 sm:col-span-3"
        />
        <input
          required
          value={href}
          onChange={(e) => setHref(e.target.value)}
          placeholder={t("links.hrefPlaceholder")}
          maxLength={500}
          className="col-span-2 rounded border border-keep-rule px-2 py-1 sm:col-span-5"
        />
        <input
          type="number"
          value={position}
          onChange={(e) => setPosition(e.target.value)}
          min={0}
          max={9999}
          title={t("links.positionTitle")}
          className="col-span-1 rounded border border-keep-rule px-2 py-1"
        />
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value as "_self" | "_blank")}
          className="col-span-1 rounded border border-keep-rule px-2 py-1 sm:col-span-2"
        >
          <option value="_blank">{t("links.targetNewTab")}</option>
          <option value="_self">{t("links.targetSameTab")}</option>
        </select>
        <button
          type="submit"
          disabled={submitting}
          className="keep-button col-span-2 rounded border border-keep-rule bg-keep-banner px-2 py-1 disabled:opacity-50 hover:bg-keep-banner/80 sm:col-span-1"
        >
          {submitting ? "..." : t("add")}
        </button>
      </div>
      {error ? <div className="mt-1 text-keep-accent">{error}</div> : null}
    </form>
  );
}

function LinkRow({
  link,
  onPatch,
  onDelete,
}: {
  link: NavLinkRow;
  onPatch: (id: string, p: Partial<NavLinkInput>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation("admin");
  const [draft, setDraft] = useState(link);
  const dirty =
    draft.label !== link.label ||
    draft.href !== link.href ||
    draft.position !== link.position ||
    draft.target !== link.target;

  async function commit() {
    await onPatch(link.id, {
      label: draft.label,
      href: draft.href,
      position: draft.position,
      target: draft.target,
    });
  }

  async function toggleEnabled() {
    await onPatch(link.id, { enabled: !link.enabled });
  }

  return (
    <tr className="border-t border-keep-rule">
      <td className="px-2 py-1">
        <input
          type="number"
          min={0}
          max={9999}
          value={draft.position}
          onChange={(e) => setDraft({ ...draft, position: parseInt(e.target.value, 10) || 0 })}
          className="w-14 rounded border border-keep-rule px-1 py-0.5"
        />
      </td>
      <td className="px-2 py-1">
        <input
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          maxLength={40}
          className="w-full rounded border border-keep-rule px-1 py-0.5"
        />
      </td>
      <td className="px-2 py-1">
        <input
          value={draft.href}
          onChange={(e) => setDraft({ ...draft, href: e.target.value })}
          maxLength={500}
          className="w-full rounded border border-keep-rule px-1 py-0.5"
        />
      </td>
      <td className="px-2 py-1">
        <select
          value={draft.target}
          onChange={(e) => setDraft({ ...draft, target: e.target.value as "_self" | "_blank" })}
          className="rounded border border-keep-rule px-1 py-0.5"
        >
          <option value="_blank">{t("links.targetNew")}</option>
          <option value="_self">{t("links.targetSame")}</option>
        </select>
      </td>
      <td className="px-2 py-1 text-center">
        <input type="checkbox" checked={link.enabled} onChange={toggleEnabled} />
      </td>
      <td className="px-2 py-1 text-right">
        {dirty ? (
          <button
            type="button"
            onClick={commit}
            className="keep-button mr-1 rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80"
          >
            {t("common:save")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onDelete(link.id)}
          className="rounded border border-keep-accent/60 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
        >
          {t("common:delete")}
        </button>
      </td>
    </tr>
  );
}
