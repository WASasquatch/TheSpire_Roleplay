import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { CharacterStats, ProfileView, Theme } from "@thekeep/shared";
import { DEFAULT_THEME, normalizeTheme } from "@thekeep/shared";
import { GENDER_OPTIONS, type Gender } from "../lib/gender.js";
import {
  isSupported as notifyIsSupported,
  permission as notifyPermission,
  requestPermission as notifyRequestPermission,
  type NotifyPref,
} from "../lib/notifications.js";
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
}

interface CharacterRow {
  id: string;
  name: string;
  bioHtml: string;
  statsJson: string;
  avatarUrl: string | null;
  themeJson: string | null;
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

  // Form state — reset whenever target changes
  const [name, setName] = useState("");
  const [bioHtml, setBioHtml] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [chatColor, setChatColor] = useState<string | null>(null);
  const [gender, setGender] = useState<Gender>("undisclosed");
  const [stats, setStats] = useState<CharacterStats>({});
  /** When the form has a theme set; null means "use default / inherit". */
  const [theme, setTheme] = useState<Theme | null>(null);
  const [notifyPref, setNotifyPref] = useState<NotifyPref>("mentions");
  // Permission state is volatile — re-read on each render via a key bump.
  const [permVersion, setPermVersion] = useState(0);

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
                }
              : c,
          ),
        );
      }
      // Stay in the editor so the user can switch to another target. Could also
      // close here — left open by design to support batch edits.
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
   * Preview pane — opens a ProfileModal showing the current form state as
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
        theme: previewTheme,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    };
  }, [target, master, name, bioHtml, avatarUrl, gender, stats, theme]);

  const targetOptions = useMemo(() => {
    return [
      { value: "master:", label: master ? `Master OOC — ${master.username}` : "Master OOC" },
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <form
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        className="flex h-[92vh] w-[min(1200px,98vw)] flex-col rounded border border-keep-rule bg-keep-parchment shadow-xl"
      >
        {/* header — fixed */}
        <div className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-4 py-2">
          <div className="flex items-center gap-2">
            <h2 className="font-action text-lg">Edit profile</h2>
            <select
              value={targetValue}
              onChange={(e) => onSelectTarget(e.target.value)}
              disabled={loadingList}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-sm"
            >
              {loadingList ? (
                <option>loading…</option>
              ) : (
                targetOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))
              )}
            </select>
          </div>
          <button type="button" onClick={onClose} className="text-sm text-keep-muted hover:text-keep-text">
            close
          </button>
        </div>

        {/* body — fills remaining height. Two columns on md+. Each column scrolls independently. */}
        {loadingTarget ? (
          <div className="flex flex-1 items-center justify-center text-keep-muted">loading…</div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[420px_1fr]">
            {/* Left: form fields, scrolls independently */}
            <div className="space-y-3 overflow-y-auto border-keep-rule p-4 md:border-r">
              <Field
                label={isCharacter ? "Character name" : "Master username"}
                value={name}
                readOnly
                hint={isCharacter ? "Renaming is blocked — message history snapshots the name at send time." : "Set at registration."}
              />
              <Field
                label="Avatar URL"
                value={avatarUrl}
                onChange={setAvatarUrl}
                placeholder="https://example.com/portrait.png"
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
                            <option value="">—</option>
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
                    Currently using the system default — change a color or pick a preset to start customizing.
                  </div>
                ) : null}
              </fieldset>

              {error ? (
                <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
                  {error}
                </div>
              ) : null}
            </div>

            {/* Right: bio editor — textarea fills column. */}
            <div className="flex min-h-0 flex-col p-4">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="uppercase tracking-widest text-keep-muted">
                  {isCharacter ? "Character bio" : "OOC bio"}
                </span>
                <span className="text-keep-muted">
                  HTML allowed: b, i, u, em, strong, a, img, br, p, ul/ol/li, blockquote, hr, h3–h6, span style=color
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
                {bioHtml.length.toLocaleString()} / 50,000
              </div>
            </div>
          </div>
        )}

        {/* footer — fixed */}
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
              {saving ? "Saving…" : "Save"}
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
    </div>
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
        <span className="text-keep-muted">— change via <code>/color &lt;hex&gt;</code> or the Tools panel.</span>
      </div>
    </div>
  );
}

/**
 * Desktop notification config — preference dropdown + permission status row.
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
        Toasts appear when this tab is hidden — minimized, on another tab, or in another app.
      </p>
      <label className="flex items-center gap-2">
        <span className="w-20 uppercase tracking-widest text-keep-muted">Notify me</span>
        <select
          value={pref}
          onChange={(e) => onChangePref(e.target.value as NotifyPref)}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
        >
          <option value="off">Off — never</option>
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
            Denied — re-enable in your browser's site permissions.
          </span>
        ) : null}
      </div>
    </fieldset>
  );
}

async function readError(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { error?: string; message?: string };
    return j.error ?? j.message ?? `${r.status} ${r.statusText}`;
  } catch {
    return `${r.status} ${r.statusText}`;
  }
}
