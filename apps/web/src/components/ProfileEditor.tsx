import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { CharacterJournalEntry, CharacterPortrait, CharacterStats, ProfileLink, ProfileView, Role, Theme } from "@thekeep/shared";
import { DEFAULT_THEME, normalizeTheme } from "@thekeep/shared";
import { GENDER_OPTIONS, type Gender } from "../lib/gender.js";
import {
  isSupported as notifyIsSupported,
  permission as notifyPermission,
  requestPermission as notifyRequestPermission,
  type NotifyPref,
} from "../lib/notifications.js";
import {
  disablePush,
  enablePush,
  readPushState,
  type PushState,
} from "../lib/push.js";
import { readError } from "../lib/http.js";
import { Modal } from "./Modal.js";
import { ProfileModal } from "./ProfileModal.js";
import { ThemePicker } from "./ThemePicker.js";

interface Props {
  /** Initial selection. The user can switch via the dropdown. */
  mode: "master" | "character";
  characterId: string | null;
  onClose: () => void;
  /**
   * Fires after every successful save so the parent can re-fetch the active
   * theme and re-apply it to the chat. The user doesn't have to close the
   * editor to see their theme change take effect.
   */
  onSaved?: () => void;
}

interface MasterData {
  username: string;
  bioHtml: string;
  avatarUrl: string | null;
  gender: Gender;
  chatColor: string | null;
  activeCharacterId: string | null;
  theme?: Theme;
  notifyPref?: NotifyPref;
  role?: Role;
  isPublic?: boolean;
  isNsfw?: boolean;
  /** Admin-tunable input caps. Surfaced so the bio counter matches the server's accept threshold. */
  limits?: { maxBioLength: number; maxMessageLength: number };
}

interface CharacterRow {
  id: string;
  name: string;
  bioHtml: string;
  statsJson: string;
  avatarUrl: string | null;
  themeJson: string | null;
  isPublic?: boolean;
  isNsfw?: boolean;
}

type Target = { kind: "master" } | { kind: "character"; id: string };

const STAT_FIELDS: Array<{ key: keyof CharacterStats; label: string }> = [
  { key: "age", label: "Age" },
  { key: "race", label: "Race" },
  { key: "gender", label: "Gender" },
  { key: "height", label: "Height" },
  { key: "weight", label: "Weight" },
  { key: "alignment", label: "Alignment" },
  { key: "occupation", label: "Occupation" },
];

/**
 * Profile editor with a target picker.
 *
 * The dropdown lists "Master account (OOC)" plus every character on the
 * account. Switching targets re-fetches that target's data and resets the
 * form. Saving is per-target and writes to the appropriate endpoint:
 *   - master       → PUT /me/profile
 *   - character    → PUT /characters/:id
 *
 * The character name and master username are read-only here. Master username
 * changes belong to account settings; character renames are blocked because
 * `messages.displayName` is snapshotted at send time and renaming would leave
 * a fragmented history.
 */
export function ProfileEditor({ mode: initialMode, characterId: initialCharId, onClose, onSaved }: Props) {
  const [target, setTarget] = useState<Target>(
    initialMode === "character" && initialCharId
      ? { kind: "character", id: initialCharId }
      : { kind: "master" },
  );
  const [characters, setCharacters] = useState<CharacterRow[]>([]);
  const [master, setMaster] = useState<MasterData | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingTarget, setLoadingTarget] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state - reset whenever target changes
  const [name, setName] = useState("");
  const [bioHtml, setBioHtml] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [chatColor, setChatColor] = useState<string | null>(null);
  const [gender, setGender] = useState<Gender>("undisclosed");
  const [stats, setStats] = useState<CharacterStats>({});
  /** When the form has a theme set; null means "use default / inherit". */
  const [theme, setTheme] = useState<Theme | null>(null);
  const [notifyPref, setNotifyPref] = useState<NotifyPref>("mentions");
  // Public + NSFW visibility flags. Default isPublic=true, isNsfw=false to
  // match the schema. NSFW=true forces isPublic=false on save (server
  // enforces this too); the UI mirrors that by disabling the Public box.
  const [isPublic, setIsPublic] = useState<boolean>(true);
  const [isNsfw, setIsNsfw] = useState<boolean>(false);
  /** Extra portraits beyond the primary avatarUrl (character targets only). */
  const [portraits, setPortraits] = useState<CharacterPortrait[]>([]);
  /** Owner-set external links rendered as styled chips on the profile. */
  const [links, setLinks] = useState<ProfileLink[]>([]);
  // Permission state is volatile - re-read on each render via a key bump.
  const [permVersion, setPermVersion] = useState(0);

  // Mobile tab. The mobile viewport (<md) can't fit both columns side-by-side
  // and shrinking either makes the form unusable - especially the bio textarea.
  // On md+ both panels render together as before; this state is ignored.
  const [mobileTab, setMobileTab] = useState<"settings" | "description">("settings");

  // "+ New character" modal toggle. When the user creates a character we POST
  // /characters, splice the row into the local list, and switch the editor's
  // target to the new character so the user lands in its editor.
  const [createOpen, setCreateOpen] = useState(false);
  // Per-character delete in-flight flag. The button stays disabled while
  // DELETE /characters/:id is pending so users can't double-submit and have
  // the second call return 404.
  const [deleting, setDeleting] = useState(false);
  const [switching, setSwitching] = useState(false);

  // Initial load: master + character list (we always need both for the dropdown).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [mRes, cRes] = await Promise.all([
          fetch("/me/profile", { credentials: "include" }),
          fetch("/characters", { credentials: "include" }),
        ]);
        if (!mRes.ok) throw new Error(await readError(mRes));
        if (!cRes.ok) throw new Error(await readError(cRes));
        const m = (await mRes.json()) as MasterData;
        const cl = (await cRes.json()) as { characters: CharacterRow[] };
        if (cancelled) return;
        setMaster(m);
        setCharacters(cl.characters);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "load failed");
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Re-populate the form whenever target changes (or its source data arrives).
  useEffect(() => {
    let cancelled = false;
    setLoadingTarget(true);
    setError(null);
    (async () => {
      try {
        if (target.kind === "master") {
          if (!master) return; // not loaded yet
          if (cancelled) return;
          setName(master.username);
          setBioHtml(master.bioHtml ?? "");
          setAvatarUrl(master.avatarUrl ?? "");
          setChatColor(master.chatColor);
          setGender(master.gender ?? "undisclosed");
          setStats({});
          setTheme(master.theme ? normalizeTheme(master.theme) : null);
          setNotifyPref(master.notifyPref ?? "mentions");
          setIsPublic(master.isPublic ?? true);
          setIsNsfw(master.isNsfw ?? false);
          setPortraits([]); // master has no gallery; only characters do
          // Master/OOC links live under /me/links (characterId IS NULL).
          try {
            const lr = await fetch("/me/links", { credentials: "include" });
            if (lr.ok) {
              const lj = (await lr.json()) as { links: ProfileLink[] };
              if (!cancelled) setLinks(lj.links);
            }
          } catch { /* links section is non-fatal */ }
          setLoadingTarget(false);
        } else {
          // Always re-fetch on switch so we have fresh statsJson; the list endpoint
          // returns the same data but we don't want to assume.
          const r = await fetch(`/characters/${target.id}`, { credentials: "include" });
          if (!r.ok) throw new Error(await readError(r));
          const c = (await r.json()) as CharacterRow;
          if (cancelled) return;
          setName(c.name);
          setBioHtml(c.bioHtml ?? "");
          setAvatarUrl(c.avatarUrl ?? "");
          setChatColor(null); // chatColor lives on the user, not per-character (yet)
          try {
            setStats(c.statsJson ? JSON.parse(c.statsJson) : {});
          } catch {
            setStats({});
          }
          if (c.themeJson) {
            try { setTheme(normalizeTheme(JSON.parse(c.themeJson))); }
            catch { setTheme(null); }
          } else {
            setTheme(null);
          }
          setIsPublic(c.isPublic ?? true);
          setIsNsfw(c.isNsfw ?? false);
          // Pull the gallery in parallel with the row fetch above? We do it
          // sequentially here to keep the early-return-on-error simple; the
          // payload is small (under 12 rows in the worst case).
          try {
            const pr = await fetch(`/characters/${target.id}/portraits`, { credentials: "include" });
            if (pr.ok) {
              const pj = (await pr.json()) as { portraits: Array<{ id: string; url: string; label: string | null; nsfw?: boolean }> };
              if (!cancelled) setPortraits(pj.portraits.map((p) => ({ id: p.id, url: p.url, label: p.label, nsfw: !!p.nsfw })));
            }
          } catch { /* gallery is non-fatal */ }
          try {
            const lr = await fetch(`/characters/${target.id}/links`, { credentials: "include" });
            if (lr.ok) {
              const lj = (await lr.json()) as { links: ProfileLink[] };
              if (!cancelled) setLinks(lj.links);
            }
          } catch { /* links section is non-fatal */ }
          setLoadingTarget(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "load failed");
          setLoadingTarget(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [target, master]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (target.kind === "master") {
        const r = await fetch("/me/profile", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bioHtml,
            avatarUrl: avatarUrl.trim() || null,
            gender,
            theme,
            notifyPref,
            isPublic,
            isNsfw,
          }),
        });
        if (!r.ok) throw new Error(await readError(r));
        // Update the in-memory master copy so the dropdown stays in sync.
        setMaster((prev) => {
          if (!prev) return prev;
          const next: MasterData = {
            ...prev,
            bioHtml,
            avatarUrl: avatarUrl.trim() || null,
            gender,
            notifyPref,
            // NSFW=true forces isPublic=false on the server. Mirror that
            // implication client-side so the cached MasterData stays
            // consistent with what the next /me/profile load would return.
            isPublic: isNsfw ? false : isPublic,
            isNsfw,
          };
          if (theme) next.theme = theme;
          else delete next.theme;
          return next;
        });
      } else {
        const r = await fetch(`/characters/${target.id}`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bioHtml,
            stats,
            avatarUrl: avatarUrl.trim() || null,
            theme,
            isPublic,
            isNsfw,
          }),
        });
        if (!r.ok) throw new Error(await readError(r));
        // Update the cached character list so the dropdown shows fresh names/avatars
        setCharacters((prev) =>
          prev.map((c) =>
            c.id === target.id
              ? {
                  ...c,
                  bioHtml,
                  statsJson: JSON.stringify(stats),
                  avatarUrl: avatarUrl.trim() || null,
                  themeJson: theme ? JSON.stringify(theme) : null,
                  isPublic: isNsfw ? false : isPublic,
                  isNsfw,
                }
              : c,
          ),
        );
      }
      // Stay in the editor so the user can switch to another target. Could also
      // close here - left open by design to support batch edits.
      flashSaved();
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  const [savedFlash, setSavedFlash] = useState(false);
  function flashSaved() {
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1500);
  }

  /**
   * Switch the user's active character to the one currently being edited.
   * Equivalent to typing `/char switch <name>` from chat. After success
   * onSaved fires so the chat re-fetches /me/profile and re-applies the
   * character's theme.
   */
  async function switchToCharacter() {
    if (target.kind !== "character") return;
    setError(null);
    setSwitching(true);
    try {
      const res = await fetch("/me/active-character", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: target.id }),
      });
      if (!res.ok) throw new Error(await readError(res));
      // Track the change locally so the Switch button hides without waiting
      // for a re-fetch of /me/profile.
      setMaster((prev) => (prev ? { ...prev, activeCharacterId: target.id } : prev));
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "switch failed");
    } finally {
      setSwitching(false);
    }
  }

  /**
   * Delete the currently-targeted character. Soft-delete on the server so
   * past chat history keeps its snapshotted name. After success we drop the
   * row from the local list and switch back to the master target.
   */
  async function deleteCharacter() {
    if (target.kind !== "character") return;
    const charName = characters.find((c) => c.id === target.id)?.name ?? "this character";
    if (!window.confirm(
      `Delete "${charName}"? Past chat history keeps the name; the character can't be restored.`,
    )) return;
    setError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/characters/${target.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      setCharacters((prev) => prev.filter((c) => c.id !== target.id));
      setTarget({ kind: "master" });
      // The active theme may change if the deleted char was active (server
      // cleared activeCharacterId, so chat falls back to the master theme).
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setDeleting(false);
    }
  }

  /**
   * Preview pane - opens a ProfileModal showing the current form state as
   * other users would see it. Pulled from local state (not the server) so
   * the user can preview unsaved edits while iterating.
   */
  const [previewing, setPreviewing] = useState(false);
  const previewProfile: ProfileView | null = useMemo(() => {
    const previewTheme = theme ?? DEFAULT_THEME;
    if (target.kind === "master") {
      if (!master) return null;
      return {
        kind: "master",
        profile: {
          userId: "preview",
          username: master.username,
          bioHtml: bioHtml,
          avatarUrl: avatarUrl.trim() || null,
          gender,
          theme: previewTheme,
          // Titles are populated server-side from accepted relationships;
          // the editor preview shows the form's contents only.
          titles: [],
          links,
          role: master.role ?? "user",
          isPublic: isNsfw ? false : isPublic,
          isNsfw,
          createdAt: Date.now(),
        },
      };
    }
    return {
      kind: "character",
      profile: {
        id: target.id,
        userId: "preview",
        name,
        bioHtml,
        stats,
        avatarUrl: avatarUrl.trim() || null,
        portraits,
        links,
        // Journal entries are managed inline in the editor (not via preview).
        // The preview ProfileModal shows the character preview as others
        // would see it, but live-fetching journal here would mix the
        // editor's "all entries" view with the modal's "public only" view.
        // Easier to leave the preview empty and let the user open the
        // actual profile to verify.
        journalEntries: [],
        theme: previewTheme,
        titles: [],
        isPublic: isNsfw ? false : isPublic,
        isNsfw,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    };
  }, [target, master, name, bioHtml, avatarUrl, gender, stats, theme, portraits, links, isPublic, isNsfw]);

  const targetOptions = useMemo(() => {
    return [
      { value: "master:", label: master ? `Master OOC - ${master.username}` : "Master OOC" },
      ...characters.map((c) => ({ value: `character:${c.id}`, label: c.name })),
    ];
  }, [master, characters]);

  function onSelectTarget(value: string) {
    if (value.startsWith("master:")) setTarget({ kind: "master" });
    else if (value.startsWith("character:")) setTarget({ kind: "character", id: value.slice(10) });
  }

  const isCharacter = target.kind === "character";
  const targetValue = target.kind === "master" ? "master:" : `character:${target.id}`;

  return (
    <Modal onClose={onClose} zIndex={50}>
      <form
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        className="flex h-[92vh] w-[min(1200px,98vw)] flex-col rounded border border-keep-rule bg-keep-parchment shadow-xl"
      >
        {/* header - fixed */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-keep-rule bg-keep-banner px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="shrink-0 font-action text-lg">Edit profile</h2>
            <select
              value={targetValue}
              onChange={(e) => onSelectTarget(e.target.value)}
              disabled={loadingList}
              className="min-w-0 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-sm"
            >
              {loadingList ? (
                <option>loading...</option>
              ) : (
                targetOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))
              )}
            </select>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              disabled={loadingList}
              title="Create a new character under your account"
              className="shrink-0 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-sm hover:bg-keep-banner disabled:opacity-50"
            >
              + New
            </button>
            {isCharacter && master && master.activeCharacterId !== (target.kind === "character" ? target.id : null) ? (
              <button
                type="button"
                onClick={switchToCharacter}
                disabled={switching || loadingTarget}
                title="Switch to this character - your chat name and theme update immediately."
                className="shrink-0 rounded border border-keep-action/60 bg-keep-bg px-2 py-0.5 text-sm text-keep-action hover:bg-keep-action/10 disabled:opacity-50"
              >
                {switching ? "Switching..." : "Switch"}
              </button>
            ) : null}
            {isCharacter ? (
              <button
                type="button"
                onClick={deleteCharacter}
                disabled={deleting || loadingTarget}
                title="Delete this character. Past message history keeps the snapshotted name."
                className="shrink-0 rounded border border-keep-accent/60 bg-keep-bg px-2 py-0.5 text-sm text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50"
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            ) : null}
          </div>
          <button type="button" onClick={onClose} className="shrink-0 text-sm text-keep-muted hover:text-keep-text">
            close
          </button>
        </div>

        {/* Mobile-only tab strip. The two panels would otherwise stack and
            crush each other on narrow viewports. md+ keeps the side-by-side
            layout and ignores this strip. */}
        <div className="flex shrink-0 border-b border-keep-rule bg-keep-banner/40 md:hidden" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mobileTab === "settings"}
            onClick={() => setMobileTab("settings")}
            className={`flex-1 px-3 py-2 text-xs uppercase tracking-widest ${
              mobileTab === "settings"
                ? "border-b-2 border-keep-action text-keep-text"
                : "text-keep-muted hover:text-keep-text"
            }`}
          >
            Settings
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileTab === "description"}
            onClick={() => setMobileTab("description")}
            className={`flex-1 px-3 py-2 text-xs uppercase tracking-widest ${
              mobileTab === "description"
                ? "border-b-2 border-keep-action text-keep-text"
                : "text-keep-muted hover:text-keep-text"
            }`}
          >
            Description
          </button>
        </div>

        {/* body - fills remaining height. Two columns on md+. Each column scrolls independently. */}
        {loadingTarget ? (
          <div className="flex flex-1 items-center justify-center text-keep-muted">loading...</div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:grid md:grid-cols-[420px_1fr]">
            {/* Left: form fields, scrolls independently. On mobile this only
                renders when the Settings tab is active and takes the full
                remaining height; on md+ it's always-visible in its grid cell.
                `md:block` overrides the mobile `hidden` at the breakpoint. */}
            <div className={`${mobileTab === "settings" ? "flex-1" : "hidden"} space-y-3 overflow-y-auto border-keep-rule p-4 md:block md:flex-initial md:border-r`}>
              <Field
                label={isCharacter ? "Character name" : "Master username"}
                value={name}
                readOnly
                hint={isCharacter ? "Renaming is blocked - message history snapshots the name at send time." : "Set at registration."}
              />
              <Field
                label="Main Profile Image URL"
                value={avatarUrl}
                onChange={setAvatarUrl}
                placeholder="https://example.com/portrait.png"
                hint="Drives the userlist icon, the modal hero, and the full-size footer image."
              />

              {!isCharacter ? (
                <label className="block text-xs">
                  <span className="mb-1 block uppercase tracking-widest text-keep-muted">Gender (OOC)</span>
                  <select
                    value={gender}
                    onChange={(e) => setGender(e.target.value as Gender)}
                    className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
                  >
                    {GENDER_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <span className="mt-1 block text-[10px] text-keep-muted">
                    Renders as an icon next to your username when no character is active.
                  </span>
                </label>
              ) : null}

              {!isCharacter ? <ColorRow current={chatColor} /> : null}

              {!isCharacter ? (
                <NotificationsRow
                  pref={notifyPref}
                  onChangePref={setNotifyPref}
                  permVersion={permVersion}
                  onPermissionChange={() => setPermVersion((v) => v + 1)}
                />
              ) : null}

              <VisibilityRow
                isPublic={isPublic}
                isNsfw={isNsfw}
                onChangePublic={setIsPublic}
                onChangeNsfw={setIsNsfw}
                kind={isCharacter ? "character" : "master"}
              />

              {isCharacter ? (
                <fieldset className="rounded border border-keep-rule p-3">
                  <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">Stats</legend>
                  <div className="grid grid-cols-2 gap-2">
                    {STAT_FIELDS.map(({ key, label }) => (
                      <label key={key} className="block text-xs">
                        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{label}</span>
                        {key === "gender" ? (
                          <select
                            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
                            value={(stats.gender as string) ?? ""}
                            onChange={(e) =>
                              setStats((s) => {
                                const next = { ...s };
                                if (e.target.value) next.gender = e.target.value;
                                else delete next.gender;
                                return next;
                              })
                            }
                          >
                            <option value="">-</option>
                            {GENDER_OPTIONS.filter((o) => o.value !== "undisclosed").map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
                            value={(stats[key] as string) ?? ""}
                            onChange={(e) =>
                              setStats((s) => ({ ...s, [key]: e.target.value || undefined }))
                            }
                          />
                        )}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}

              {isCharacter && target.kind === "character" ? (
                <PortraitGalleryEditor
                  characterId={target.id}
                  portraits={portraits}
                  onChange={setPortraits}
                />
              ) : null}

              {isCharacter && target.kind === "character" ? (
                <JournalEditor characterId={target.id} />
              ) : null}

              <LinksEditor
                scope={target.kind === "character" ? { kind: "character", id: target.id } : { kind: "master" }}
                links={links}
                onChange={setLinks}
              />

              <fieldset className="rounded border border-keep-rule p-3">
                <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">
                  {isCharacter ? "Character theme" : "OOC theme"}
                </legend>
                <p className="mb-2 text-[10px] text-keep-muted">
                  {isCharacter
                    ? "Switching to this character applies this theme to your chat. Others viewing this character's profile see it themed this way."
                    : "Applied to your chat when no character is active, and to your master profile modal."}
                </p>
                <ThemePicker
                  theme={theme ?? DEFAULT_THEME}
                  onChange={setTheme}
                  onReset={() => setTheme(null)}
                />
                {!theme ? (
                  <div className="mt-1 text-[10px] italic text-keep-muted">
                    Currently using the system default - change a color or pick a preset to start customizing.
                  </div>
                ) : null}
              </fieldset>

              {error ? (
                <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
                  {error}
                </div>
              ) : null}
            </div>

            {/* Right: bio editor - textarea fills column. On mobile only
                renders when the Description tab is active. `md:flex` overrides
                the mobile `hidden` so on md+ it always shows alongside the
                settings column. */}
            <div className={`${mobileTab === "description" ? "flex flex-1" : "hidden"} min-h-0 flex-col p-4 md:flex md:flex-initial`}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="uppercase tracking-widest text-keep-muted">
                  {isCharacter ? "Character bio" : "OOC bio"}
                </span>
                <span className="hidden text-keep-muted md:inline">
                  HTML allowed: b, i, u, em, strong, a, img, br, p, ul/ol/li, blockquote, hr, h3-h6, span style=color
                </span>
              </div>
              <textarea
                value={bioHtml}
                onChange={(e) => setBioHtml(e.target.value)}
                className="min-h-0 w-full flex-1 resize-none rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs outline-none focus:border-keep-action"
                placeholder={
                  isCharacter
                    ? "<p>A weather-beaten mercenary from the Reach...</p>"
                    : "<p>Time-zone, contact preferences, RP boundaries, anything OOC.</p>"
                }
              />
              <div className="mt-1 text-right text-[10px] text-keep-muted tabular-nums">
                {bioHtml.length.toLocaleString()} / {(master?.limits?.maxBioLength ?? 50_000).toLocaleString()}
              </div>
            </div>
          </div>
        )}

        {/* footer - fixed */}
        <div className="flex shrink-0 items-center justify-between border-t border-keep-rule bg-keep-banner/40 p-2">
          <span className={`text-xs ${savedFlash ? "text-keep-system" : "text-keep-muted"}`}>
            {savedFlash ? "Saved." : ""}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPreviewing(true)}
              disabled={loadingTarget || !previewProfile}
              title="Preview this profile as other users will see it (uses your unsaved edits)."
              className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm disabled:opacity-50 hover:bg-keep-banner"
            >
              View profile
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm hover:bg-keep-banner"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={saving || loadingTarget}
              className="rounded border border-keep-rule bg-keep-banner px-4 py-1 text-sm disabled:opacity-50 hover:bg-keep-banner/80"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </form>
      {previewing && previewProfile ? (
        // stopPropagation so clicking the preview backdrop (which closes the
        // preview) doesn't bubble to the editor's backdrop and close that too.
        <div onClick={(e) => e.stopPropagation()}>
          <ProfileModal profile={previewProfile} onClose={() => setPreviewing(false)} />
        </div>
      ) : null}
      {createOpen ? (
        <div onClick={(e) => e.stopPropagation()}>
          <CreateCharacterModal
            onCancel={() => setCreateOpen(false)}
            onCreated={(c) => {
              setCharacters((prev) => [...prev, c]);
              setTarget({ kind: "character", id: c.id });
              // Drop the user onto the description tab so they can start
              // writing immediately on mobile - the settings tab is mostly
              // empty for a brand-new character.
              setMobileTab("description");
              setCreateOpen(false);
            }}
          />
        </div>
      ) : null}
    </Modal>
  );
}

/**
 * Name-prompt modal for creating a new character. POSTs /characters and on
 * success returns the new row to the parent so the editor can navigate to it.
 * Server is authoritative on validation; the client-side regex is a fast
 * pre-check so users get immediate feedback for bad chars.
 */
function CreateCharacterModal({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (c: CharacterRow) => void;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const localValid = /^[\p{L}\p{N}_\-' ]{1,40}$/u.test(trimmed);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!localValid || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/characters", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const c = (await res.json()) as CharacterRow;
      onCreated(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal onClose={onCancel} zIndex={60}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-[min(420px,96vw)] rounded border border-keep-rule bg-keep-parchment p-4 shadow-xl"
      >
        <h3 className="mb-2 font-action text-lg">New character</h3>
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Character name</span>
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. JohnSmith"
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-base outline-none focus:border-keep-action md:text-sm"
          />
        </label>
        <p className="mt-1 text-[10px] text-keep-muted">
          1-40 chars: letters, numbers, spaces, _ - '. Character names can't be changed, choose wisely.
        </p>
        {error ? (
          <div className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
            {error}
          </div>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm hover:bg-keep-banner"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!localValid || submitting}
            className="rounded border border-keep-rule bg-keep-banner px-3 py-1 text-sm hover:bg-keep-banner/80 disabled:opacity-50"
          >
            {submitting ? "Creating..." : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Multi-portrait gallery management UI for character targets. Add by URL,
 * label, delete. Reordering deferred — most galleries are small and the
 * primary avatarUrl already drives the hero/userlist icon.
 *
 * Each mutation hits the server immediately so the gallery stays consistent
 * with what others see — no "save" button per portrait.
 */
function PortraitGalleryEditor({
  characterId,
  portraits,
  onChange,
}: {
  characterId: string;
  portraits: CharacterPortrait[];
  onChange: (next: CharacterPortrait[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [nsfw, setNsfw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    const u = url.trim();
    if (!u) return;
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch(`/characters/${characterId}/portraits`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: u,
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(nsfw ? { nsfw: true } : {}),
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const row = (await res.json()) as { id: string; url: string; label: string | null; nsfw: boolean };
      onChange([...portraits, { id: row.id, url: row.url, label: row.label, nsfw: !!row.nsfw }]);
      setUrl("");
      setLabel("");
      setNsfw(false);
      setAdding(false);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "add failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Remove this portrait from the gallery?")) return;
    try {
      const res = await fetch(`/characters/${characterId}/portraits/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      onChange(portraits.filter((p) => p.id !== id));
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "delete failed");
    }
  }

  /** Toggle a portrait's NSFW flag in-place. */
  async function toggleNsfw(id: string, next: boolean) {
    try {
      const res = await fetch(`/characters/${characterId}/portraits/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nsfw: next }),
      });
      if (!res.ok) throw new Error(await readError(res));
      onChange(portraits.map((p) => (p.id === id ? { ...p, nsfw: next } : p)));
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "toggle failed");
    }
  }

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Gallery</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        Extra portraits shown beneath the bio on this character's profile. The Main Profile Image above is the one rendered first (userlist, modal hero, full-size footer). Mark a tile NSFW to blur it for viewers (they can click to reveal).
      </p>
      {portraits.length > 0 ? (
        <div className="mb-2 grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-2">
          {portraits.map((p) => (
            <div key={p.id} className="relative">
              <img
                src={p.url}
                alt={p.label ?? "portrait"}
                className={`aspect-square w-full rounded border border-keep-border object-cover ${p.nsfw ? "blur-md scale-105" : ""}`}
              />
              <button
                type="button"
                onClick={() => toggleNsfw(p.id, !p.nsfw)}
                title={p.nsfw ? "Marked NSFW (blurred for viewers) - click to unmark." : "Mark NSFW so viewers see this tile blurred until they reveal."}
                aria-label="Toggle NSFW"
                aria-pressed={p.nsfw}
                className={`absolute bottom-0 left-0 rounded-bl rounded-tr border border-keep-rule px-1 text-[10px] ${
                  p.nsfw ? "bg-keep-accent text-white" : "bg-keep-bg/80 text-keep-muted hover:bg-keep-banner"
                }`}
              >
                NSFW
              </button>
              <button
                type="button"
                onClick={() => remove(p.id)}
                title="Remove portrait"
                aria-label="Remove portrait"
                className="absolute right-0 top-0 rounded-bl rounded-tr border border-keep-rule bg-keep-bg/80 px-1 text-[10px] text-keep-accent hover:bg-keep-accent/10"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mb-2 italic text-keep-muted">No extra portraits yet.</p>
      )}
      {adding ? (
        <form onSubmit={add} className="space-y-1">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/portrait.png"
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
          />
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional - e.g. 'transformed')"
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
          />
          <label className="flex items-center gap-1 text-[11px] text-keep-muted">
            <input
              type="checkbox"
              checked={nsfw}
              onChange={(e) => setNsfw(e.target.checked)}
              className="h-3 w-3"
            />
            <span>Mark NSFW (viewers see this blurred until they reveal it)</span>
          </label>
          {err ? <div className="text-[10px] text-keep-accent">{err}</div> : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setAdding(false); setUrl(""); setLabel(""); setNsfw(false); setErr(null); }}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !url.trim()}
              className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
            >
              {busy ? "Adding..." : "Add"}
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
        >
          + Add portrait
        </button>
      )}
    </fieldset>
  );
}

/* ============================================================
 *  LinksEditor — owner-set external links rendered as styled
 *  chips on the profile. Up to 6 per profile (server-enforced).
 * ============================================================ */

type LinksScope = { kind: "master" } | { kind: "character"; id: string };

const LINKS_CAP = 6;
const LINK_DEFAULT_BORDER = "#a89572";
const LINK_DEFAULT_BG = "#e2d6b8";
const LINK_DEFAULT_TEXT = "#2c5d2c";

function linksEndpoint(scope: LinksScope): string {
  return scope.kind === "master" ? "/me/links" : `/characters/${scope.id}/links`;
}

function LinksEditor({
  scope,
  links,
  onChange,
}: {
  scope: LinksScope;
  links: ProfileLink[];
  onChange: (next: ProfileLink[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [customColors, setCustomColors] = useState(false);
  const [borderColor, setBorderColor] = useState(LINK_DEFAULT_BORDER);
  const [bgColor, setBgColor] = useState(LINK_DEFAULT_BG);
  const [textColor, setTextColor] = useState(LINK_DEFAULT_TEXT);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function resetForm() {
    setTitle("");
    setUrl("");
    setCustomColors(false);
    setBorderColor(LINK_DEFAULT_BORDER);
    setBgColor(LINK_DEFAULT_BG);
    setTextColor(LINK_DEFAULT_TEXT);
    setErr(null);
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !url.trim()) return;
    setErr(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { title: title.trim(), url: url.trim() };
      if (customColors) {
        body.borderColor = borderColor;
        body.bgColor = bgColor;
        body.textColor = textColor;
      }
      const res = await fetch(linksEndpoint(scope), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res));
      const row = (await res.json()) as ProfileLink;
      onChange([...links, row]);
      resetForm();
      setAdding(false);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "add failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Remove this link?")) return;
    try {
      const res = await fetch(`${linksEndpoint(scope)}/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      onChange(links.filter((l) => l.id !== id));
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "delete failed");
    }
  }

  const atCap = links.length >= LINKS_CAP;

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Profile links</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        Up to {LINKS_CAP} external links rendered as styled chips on this profile. Useful for cross-site character profiles, world docs, refs. They open in a new tab.
      </p>
      {links.length > 0 ? (
        <ul className="mb-2 space-y-1">
          {links.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 rounded border border-keep-rule/60 bg-keep-bg px-2 py-1">
              <span
                className="inline-block truncate rounded border px-1.5 py-0.5 text-[11px]"
                style={{
                  borderColor: l.borderColor ?? "rgb(var(--keep-border))",
                  backgroundColor: l.bgColor ?? "rgb(var(--keep-panel))",
                  color: l.textColor ?? "rgb(var(--keep-action))",
                }}
                title={l.url}
              >
                {l.title}
              </span>
              <span className="truncate text-[10px] text-keep-muted">{l.url}</span>
              <button
                type="button"
                onClick={() => remove(l.id)}
                title="Remove link"
                aria-label="Remove link"
                className="shrink-0 rounded border border-keep-accent/50 bg-keep-bg px-1.5 py-0 text-[10px] text-keep-accent hover:bg-keep-accent/10"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-2 italic text-keep-muted">No links yet.</p>
      )}
      {adding ? (
        <form onSubmit={add} className="space-y-1">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (e.g. 'F-List profile')"
            maxLength={60}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
          />
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/your-profile"
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
          />
          <label className="flex items-center gap-1 text-[11px] text-keep-muted">
            <input
              type="checkbox"
              checked={customColors}
              onChange={(e) => setCustomColors(e.target.checked)}
              className="h-3 w-3"
            />
            <span>Customize chip colors</span>
          </label>
          {customColors ? (
            <div className="grid grid-cols-3 gap-2">
              <label className="flex flex-col text-[10px] text-keep-muted">
                <span className="uppercase tracking-widest">Border</span>
                <input type="color" value={borderColor} onChange={(e) => setBorderColor(e.target.value)} className="h-6 w-full rounded border border-keep-rule" />
              </label>
              <label className="flex flex-col text-[10px] text-keep-muted">
                <span className="uppercase tracking-widest">Background</span>
                <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} className="h-6 w-full rounded border border-keep-rule" />
              </label>
              <label className="flex flex-col text-[10px] text-keep-muted">
                <span className="uppercase tracking-widest">Text</span>
                <input type="color" value={textColor} onChange={(e) => setTextColor(e.target.value)} className="h-6 w-full rounded border border-keep-rule" />
              </label>
            </div>
          ) : null}
          {customColors ? (
            <div className="mt-1 text-[10px] text-keep-muted">
              Preview:{" "}
              <span
                className="inline-block rounded border px-1.5 py-0.5 text-[11px]"
                style={{ borderColor, backgroundColor: bgColor, color: textColor }}
              >
                {title.trim() || "Sample link"}
              </span>
            </div>
          ) : null}
          {err ? <div className="text-[10px] text-keep-accent">{err}</div> : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setAdding(false); resetForm(); }}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !title.trim() || !url.trim()}
              className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
            >
              {busy ? "Adding..." : "Add"}
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={atCap}
          title={atCap ? `Limit of ${LINKS_CAP} links per profile.` : undefined}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner disabled:opacity-50"
        >
          + Add link
        </button>
      )}
    </fieldset>
  );
}

function Field({
  label,
  value,
  onChange,
  readOnly,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block uppercase tracking-widest text-keep-muted">{label}</span>
      <input
        type="text"
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={(e) => onChange?.(e.target.value)}
        className={`w-full rounded border border-keep-rule px-2 py-1 outline-none ${
          readOnly ? "bg-keep-banner/30 text-keep-muted" : "bg-keep-bg focus:border-keep-action"
        }`}
      />
      {hint ? <span className="mt-1 block text-[10px] text-keep-muted">{hint}</span> : null}
    </label>
  );
}

function ColorRow({ current }: { current: string | null }) {
  return (
    <div className="rounded border border-keep-rule bg-keep-banner/30 p-2 text-xs">
      <div className="mb-1 uppercase tracking-widest text-keep-muted">Chat color</div>
      <div className="flex items-center gap-2">
        {current ? (
          <span
            className="inline-block h-4 w-8 rounded border border-keep-rule"
            style={{ backgroundColor: current }}
          />
        ) : null}
        <span className="font-mono">{current ?? "(default)"}</span>
        <span className="text-keep-muted">- change via <code>/color &lt;hex&gt;</code> or the Tools panel.</span>
      </div>
    </div>
  );
}

/**
 * Desktop notification config - preference dropdown + permission status row.
 * Browsers require permission to be requested from a user gesture, so we
 * expose an explicit "Enable" button rather than asking on mount.
 */
function NotificationsRow({
  pref,
  onChangePref,
  permVersion,
  onPermissionChange,
}: {
  pref: NotifyPref;
  onChangePref: (p: NotifyPref) => void;
  permVersion: number;
  onPermissionChange: () => void;
}) {
  // permVersion is unused inside but its presence forces a re-read of permission()
  // when the parent bumps it after a permission grant/deny.
  void permVersion;
  const perm = notifyPermission();
  const supported = notifyIsSupported();

  async function enable() {
    await notifyRequestPermission();
    onPermissionChange();
  }

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Desktop notifications</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        Toasts appear when this tab is hidden - minimized, on another tab, or in another app.
      </p>
      <label className="flex items-center gap-2">
        <span className="w-20 uppercase tracking-widest text-keep-muted">Notify me</span>
        <select
          value={pref}
          onChange={(e) => onChangePref(e.target.value as NotifyPref)}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
        >
          <option value="off">Off - never</option>
          <option value="mentions">Whispers &amp; announcements only</option>
          <option value="all">All messages in rooms I'm in</option>
        </select>
      </label>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-keep-muted">
          Browser permission:{" "}
          <span className="font-mono">{supported ? perm : "unsupported"}</span>
        </span>
        {supported && perm === "default" ? (
          <button
            type="button"
            onClick={enable}
            className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80"
          >
            Enable
          </button>
        ) : supported && perm === "denied" ? (
          <span className="text-[10px] text-keep-accent">
            Denied - re-enable in your browser's site permissions.
          </span>
        ) : null}
      </div>
      <PushRow />
    </fieldset>
  );
}

/**
 * Profile visibility + NSFW gate.
 *
 * Two checkboxes:
 *   - Public: when off, the profile is hidden from anonymous viewers
 *     (logged-out visitors get 404 from /profiles/:name).
 *   - NSFW: pre-gates the whole profile. Logged-in viewers see a warning
 *     splash with a "View Profile" button before the content renders.
 *     The owner + admins always skip the gate.
 *
 * NSFW=true forces Public=false (server enforces; the UI mirrors by
 * disabling and unchecking the Public box). Independent of the per-portrait
 * NSFW flag we already shipped, which only blurs individual gallery images.
 */
function VisibilityRow({
  isPublic,
  isNsfw,
  onChangePublic,
  onChangeNsfw,
  kind,
}: {
  isPublic: boolean;
  isNsfw: boolean;
  onChangePublic: (v: boolean) => void;
  onChangeNsfw: (v: boolean) => void;
  kind: "master" | "character";
}) {
  const subject = kind === "master" ? "your master profile" : "this character's profile";
  // When NSFW is on, the Public box is disabled and visually shows as
  // unchecked - matches the server's normalization on save.
  const effectivePublic = isNsfw ? false : isPublic;
  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Visibility</legend>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={effectivePublic}
          disabled={isNsfw}
          onChange={(e) => onChangePublic(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-semibold">Public</span>
          <span className="block text-[10px] text-keep-muted">
            Anyone (including logged-out visitors) can view {subject} via{" "}
            <code>/profiles/{kind === "master" ? "<username>" : "<character>"}</code>. Uncheck to
            require login.
          </span>
        </span>
      </label>
      <label className="mt-2 flex items-start gap-2">
        <input
          type="checkbox"
          checked={isNsfw}
          onChange={(e) => onChangeNsfw(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-semibold">NSFW (whole profile)</span>
          <span className="block text-[10px] text-keep-muted">
            Forces non-public to anonymous viewers, and shows a warning splash with a "View
            Profile" button to logged-in viewers before the content renders. Use when the
            profile itself is explicit (independent of marking individual gallery images NSFW).
          </span>
        </span>
      </label>
    </fieldset>
  );
}

/**
 * Web Push (offline notifications) opt-in. Sits inside NotificationsRow so
 * the user sees both surfaces in one place: foreground toasts (browser
 * Notification API) and background pushes (service worker).
 *
 * Privacy reminder rendered alongside the toggle: payloads carry no message
 * body, only "you have a whisper / mention waiting".
 */
function PushRow() {
  const [state, setState] = useState<PushState | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    readPushState().then((s) => { if (!cancelled) setState(s); });
    return () => { cancelled = true; };
  }, []);

  async function turnOn() {
    setError(null);
    setBusy(true);
    try {
      const next = await enablePush();
      setState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "enable failed");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setError(null);
    setBusy(true);
    try {
      const next = await disablePush();
      setState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "disable failed");
    } finally {
      setBusy(false);
    }
  }

  if (state === "unsupported") {
    return (
      <div className="mt-2 text-[10px] italic text-keep-muted">
        Browser push isn't available in this browser.
      </div>
    );
  }

  return (
    <div className="mt-2 border-t border-keep-rule/50 pt-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-keep-text">Browser push (offline)</div>
          <div className="text-[10px] text-keep-muted">
            Pings even when this tab is closed. Privacy: payloads carry no message body — just "whisper waiting" / "mention waiting".
          </div>
        </div>
        {state === "loading" ? (
          <span className="text-[10px] text-keep-muted">…</span>
        ) : state === "denied" ? (
          <span className="text-[10px] text-keep-accent">Permission denied</span>
        ) : state === "subscribed" ? (
          <button
            type="button"
            onClick={turnOff}
            disabled={busy}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs hover:bg-keep-banner disabled:opacity-50"
          >
            {busy ? "..." : "Disable"}
          </button>
        ) : (
          <button
            type="button"
            onClick={turnOn}
            disabled={busy}
            className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 text-xs hover:bg-keep-banner/80 disabled:opacity-50"
          >
            {busy ? "..." : "Enable"}
          </button>
        )}
      </div>
      {error ? <div className="mt-1 text-[10px] text-keep-accent">{error}</div> : null}
    </div>
  );
}

/* ============================================================
 *  JournalEditor — owner-only solo writing attached to a
 *  character. Public entries surface on the profile in
 *  chronological order; private entries only show here.
 * ============================================================ */
function JournalEditor({ characterId }: { characterId: string }) {
  const [entries, setEntries] = useState<CharacterJournalEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const r = await fetch(`/characters/${characterId}/journal`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { entries: CharacterJournalEntry[] };
      setEntries(j.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [characterId]);

  async function remove(id: string) {
    if (!window.confirm("Delete this journal entry?")) return;
    try {
      const r = await fetch(`/characters/${characterId}/journal/${id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  }

  async function save(body: { title: string | null; bodyHtml: string; privacy: "public" | "private" }, id?: string) {
    try {
      const url = id
        ? `/characters/${characterId}/journal/${id}`
        : `/characters/${characterId}/journal`;
      const method = id ? "PATCH" : "POST";
      const r = await fetch(url, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
      setCreating(false);
      setEditingId(null);
    } catch (e) {
      throw e;
    }
  }

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Journal</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        Solo writing attached to this character. Backstory, in-world diary, world notes. Public entries surface on
        the profile chronologically. Private entries are only visible to you.
      </p>
      {error ? <div className="mb-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-keep-accent">{error}</div> : null}
      {creating ? (
        <JournalEntryForm
          mode="create"
          onCancel={() => setCreating(false)}
          onSave={(body) => save(body)}
        />
      ) : null}
      {entries === null ? (
        <p className="italic text-keep-muted">Loading entries...</p>
      ) : entries.length === 0 ? (
        <p className="italic text-keep-muted">No entries yet.</p>
      ) : (
        <ol className="space-y-2">
          {entries.map((e) => (
            <li key={e.id} className="rounded border border-keep-rule/60 bg-keep-bg p-2">
              {editingId === e.id ? (
                <JournalEntryForm
                  mode="edit"
                  initial={e}
                  onCancel={() => setEditingId(null)}
                  onSave={(body) => save(body, e.id)}
                />
              ) : (
                <>
                  <header className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold">
                      {e.title || <span className="italic text-keep-muted">untitled</span>}
                      <span
                        className={`ml-2 rounded px-1 text-[10px] uppercase tracking-widest ${
                          e.privacy === "public"
                            ? "bg-keep-action/15 text-keep-action"
                            : "bg-keep-rule/30 text-keep-muted"
                        }`}
                      >
                        {e.privacy}
                      </span>
                    </span>
                    <span className="text-[10px] text-keep-muted">
                      {new Date(e.createdAt).toLocaleDateString()}
                    </span>
                  </header>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[10px] uppercase tracking-widest text-keep-muted">Preview</summary>
                    <div className="mt-1 max-h-40 overflow-y-auto rounded border border-keep-rule/40 bg-keep-panel/30 p-2 font-mono text-[11px]">
                      {e.bodyHtml}
                    </div>
                  </details>
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingId(e.id)}
                      className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(e.id)}
                      className="rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      {!creating && editingId === null ? (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="mt-2 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
        >
          + Add entry
        </button>
      ) : null}
    </fieldset>
  );
}

function JournalEntryForm({
  mode,
  initial,
  onCancel,
  onSave,
}: {
  mode: "create" | "edit";
  initial?: CharacterJournalEntry;
  onCancel: () => void;
  onSave: (body: { title: string | null; bodyHtml: string; privacy: "public" | "private" }) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [bodyHtml, setBodyHtml] = useState(initial?.bodyHtml ?? "");
  const [privacy, setPrivacy] = useState<"public" | "private">(initial?.privacy ?? "public");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!bodyHtml.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave({
        title: title.trim() || null,
        bodyHtml: bodyHtml,
        privacy,
      });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-1">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={120}
        placeholder="Title (optional)"
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
      />
      <textarea
        value={bodyHtml}
        onChange={(e) => setBodyHtml(e.target.value)}
        rows={8}
        placeholder={"<p>Write your entry here. The same HTML allow-list as your bio applies (b, i, em, p, ul/ol/li, blockquote, h3-h6, etc.).</p>"}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-keep-action"
      />
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1 text-[11px] text-keep-muted">
          <span>Visibility:</span>
          <select
            value={privacy}
            onChange={(e) => setPrivacy(e.target.value as "public" | "private")}
            className="rounded border border-keep-rule bg-keep-bg px-1 py-0.5"
          >
            <option value="public">Public (on profile)</option>
            <option value="private">Private (only you)</option>
          </select>
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !bodyHtml.trim()}
            className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
          >
            {busy ? "Saving..." : mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      </div>
      {err ? <div className="text-[10px] text-keep-accent">{err}</div> : null}
    </form>
  );
}
