import DOMPurify from "dompurify";
import { useEffect, useState } from "react";
import type { OnboardingConfig } from "@thekeep/shared";
import { Modal } from "./Modal.js";

interface Props {
  /** The server whose onboarding flow to run. */
  serverId: string;
  /**
   * Sanitized server welcome HTML rendered as the flow's header (the same copy
   * the WelcomeModal shows for a server). Optional — omitted or blank simply
   * drops the header. IntA already has this from the server dossier
   * (`ServerDetail.welcomeHtml`); the modal DOMPurifies it a second time as
   * defense-in-depth, mirroring WelcomeModal.
   */
  welcomeHtml?: string | null;
  /** Server name, used for the header title fallback when there's no welcome copy. */
  serverName?: string | undefined;
  /**
   * Called once the flow is finished (completed, skipped, or the config turned
   * out empty). The parent should hide the modal; the server has recorded the
   * completion hash so it won't re-show until the owner edits the flow.
   */
  onDone: () => void;
}

/** A single prompt's chosen usergroup ids (keyed by prompt id). */
type Answers = Record<string, string[]>;

/**
 * Server onboarding flow — a richer sibling of WelcomeModal. On server entry IntA
 * mounts this (after checking GET /servers/:id/onboarding reported `!completed`).
 * It fetches the server's OnboardingConfig, renders the welcome header plus each
 * prompt (radio for `single`, checkbox for `multi`), and on submit POSTs the
 * selected usergroup ids to /servers/:id/onboarding/complete — which grants the
 * member_selectable roles and stamps the completion hash so the flow is one-shot
 * (re-shows only when the owner edits it, changing the hash).
 *
 * Defensive UX: if the config is empty, the fetch fails, or the caller already
 * completed it, the modal resolves via `onDone` without blocking the member.
 */
export function ServerOnboardingModal({ serverId, welcomeHtml, serverName, onDone }: Props) {
  const [config, setConfig] = useState<OnboardingConfig | null>(null);
  const [hash, setHash] = useState("");
  const [answers, setAnswers] = useState<Answers>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the flow once. If onboarding is off/empty/already done, resolve
  // immediately so we never show an empty modal.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/servers/${encodeURIComponent(serverId)}/onboarding`, {
          credentials: "include",
        });
        const j = (await res.json()) as {
          config?: OnboardingConfig;
          hash?: string;
          completed?: boolean;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || j.error) {
          // Can't onboard (flag off, not a participant, etc.) — don't block.
          onDone();
          return;
        }
        const cfg = j.config ?? { prompts: [] };
        if (j.completed || cfg.prompts.length === 0) {
          onDone();
          return;
        }
        setConfig(cfg);
        setHash(j.hash ?? "");
        setLoading(false);
      } catch {
        if (!cancelled) onDone();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, onDone]);

  function toggleSingle(promptId: string, usergroupId: string) {
    setAnswers((prev) => ({ ...prev, [promptId]: [usergroupId] }));
  }

  function toggleMulti(promptId: string, usergroupId: string) {
    setAnswers((prev) => {
      const cur = prev[promptId] ?? [];
      const next = cur.includes(usergroupId)
        ? cur.filter((x) => x !== usergroupId)
        : [...cur, usergroupId];
      return { ...prev, [promptId]: next };
    });
  }

  // Continue flattens every chosen usergroup id across prompts; de-dupe (an id
  // can only be granted once). The server re-validates each against the config +
  // member_selectable, so a stale/bad id is simply dropped. Skip passes an empty
  // set so it records completion without granting anything the member ticked.
  const submitContinue = () => submit([...new Set(Object.values(answers).flat())]);
  const submitSkip = () => submit([]);

  async function submit(selections: string[]) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/servers/${encodeURIComponent(serverId)}/onboarding/complete`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash, selections }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      onDone();
    } catch {
      setError("Network error. Please try again.");
      setSubmitting(false);
    }
  }

  // Nothing to render while we decide whether there's a flow to show. Returning
  // an empty portal-less fragment avoids a flash of an empty card.
  if (loading || !config) return null;

  const cleanWelcome = welcomeHtml?.trim() ? DOMPurify.sanitize(welcomeHtml) : "";
  const title = serverName ? `Welcome to ${serverName}` : "Welcome";

  return (
    // Backdrop + Esc disabled: the flow resolves only through the buttons so the
    // completion hash is always recorded for what the member saw (mirrors
    // WelcomeModal's explicit-dismiss contract).
    <Modal onClose={onDone} closeOnBackdrop={false} closeOnEscape={false} zIndex={50}>
      <div
        className="keep-frame flex max-h-[85vh] w-full flex-col overflow-hidden rounded bg-keep-bg text-keep-text md:w-[min(720px,78vw)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-4 py-2">
          <h2 className="font-action text-lg">{title}</h2>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {cleanWelcome ? (
            <div
              className="prose prose-sm mb-5 max-w-none break-words"
              dangerouslySetInnerHTML={{ __html: cleanWelcome }}
            />
          ) : null}

          <p className="mb-4 text-sm text-keep-text/70">
            Pick a few roles to get started. You can change these any time.
          </p>

          <div className="flex flex-col gap-5">
            {config.prompts.map((prompt) => {
              const selected = answers[prompt.id] ?? [];
              return (
                <fieldset key={prompt.id} className="rounded border border-keep-rule bg-keep-panel/30 p-3">
                  <legend className="px-1 text-sm font-semibold text-keep-text">{prompt.label}</legend>
                  {prompt.help ? (
                    <p className="mb-2 px-1 text-xs text-keep-text/60">{prompt.help}</p>
                  ) : null}
                  <div className="flex flex-col gap-1.5">
                    {prompt.options.map((opt) => {
                      const checked = selected.includes(opt.usergroupId);
                      return (
                        <label
                          key={opt.usergroupId}
                          className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 hover:bg-keep-panel/50"
                        >
                          <input
                            type={prompt.kind === "single" ? "radio" : "checkbox"}
                            name={`onboard-${prompt.id}`}
                            checked={checked}
                            onChange={() =>
                              prompt.kind === "single"
                                ? toggleSingle(prompt.id, opt.usergroupId)
                                : toggleMulti(prompt.id, opt.usergroupId)
                            }
                            className="mt-0.5 accent-keep-action"
                          />
                          <span className="text-sm text-keep-text">{opt.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              );
            })}
          </div>

          {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-keep-rule bg-keep-panel/40 px-4 py-2">
          {/* Skip records completion with no roles granted so the member isn't
              nagged; they can still self-pick roles later. It submits an EMPTY
              selection set so any options ticked before skipping are discarded. */}
          <button
            type="button"
            onClick={submitSkip}
            disabled={submitting}
            className="rounded border border-keep-rule bg-keep-panel/40 px-3 py-1 text-sm text-keep-text/80 hover:bg-keep-panel/70 disabled:opacity-50"
          >
            Skip for now
          </button>
          <button
            type="button"
            onClick={submitContinue}
            disabled={submitting}
            className="rounded border border-keep-action/60 bg-keep-action/10 px-3 py-1 text-sm font-semibold text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
          >
            {submitting ? "Saving..." : "Continue"}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
