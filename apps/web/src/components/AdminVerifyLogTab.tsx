/**
 * Admin → Verify Log tool.
 *
 * Staff paste or drop a submitted `/export` chat log. We send the raw text
 * to POST /admin/export/verify, which extracts the file's inert signed
 * manifest, checks the HMAC against the server key, and cross-checks the
 * receipt recorded at export time. We render the verdict, the receipt
 * details, and the SIGNED messages — read what was signed, not the visible
 * HTML (which could have been edited). Message bodies render as plain text
 * (React escapes them) so nothing in a log can execute here.
 *
 * Gated on `verify_export_logs` (the outer AdminPanel hides the whole tab).
 */
import { useCallback, useRef, useState } from "react";

interface VerifyMessage {
  id: string;
  kind: string;
  displayName: string;
  body: string;
  color: string | null;
  createdAt: number;
  toDisplayName: string | null;
  moodSnapshot: string | null;
  npcVoicedBy: string | null;
}

interface VerifyResponse {
  found: boolean;
  valid: boolean;
  reason?: string;
  receiptId?: string;
  meta?: {
    roomName: string;
    exportedByUsername: string;
    generatedAtMs: number;
    windowMs: number;
    rangeStartMs: number;
    rangeEndMs: number;
    messageCount: number;
    truncated: boolean;
  };
  stored?: {
    exists: boolean;
    matchesHash: boolean;
    generatedAt?: number;
    exportedByUsername?: string;
    roomName?: string;
    messageCount?: number;
  };
  messages?: VerifyMessage[];
}

function fmtTime(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Cap how much a single textarea/file holds; the server caps it too. */
const MAX_CHARS = 50_000_000;

export function AdminVerifyLogTab() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const readFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? "").slice(0, MAX_CHARS);
      setText(content);
      setResult(null);
      setError(null);
    };
    reader.onerror = () => setError("Couldn't read that file.");
    reader.readAsText(file);
  }, []);

  const verify = useCallback(async () => {
    const file = text.trim();
    if (!file) { setError("Paste a log or drop the exported .html file first."); return; }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch("/admin/export/verify", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file }),
      });
      if (!r.ok) throw new Error(`verify ${r.status}`);
      setResult((await r.json()) as VerifyResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification request failed.");
    } finally {
      setBusy(false);
    }
  }, [text]);

  // Verdict: authentic (signed + receipt matches), authentic-but-no-receipt
  // (rare: receipt pruned), or failed.
  const verdict = (() => {
    if (!result) return null;
    if (!result.found) return { tone: "bad", label: "No verification data", detail: result.reason } as const;
    if (!result.valid) return { tone: "bad", label: "Altered or not from this server", detail: result.reason } as const;
    if (result.stored?.exists && result.stored.matchesHash) {
      return { tone: "good", label: "Authentic — signature valid, matches server record", detail: undefined } as const;
    }
    if (result.stored?.exists && !result.stored.matchesHash) {
      return { tone: "bad", label: "Signature valid but does NOT match the server's recorded export", detail: "The receipt exists but its content hash differs. Treat with suspicion." } as const;
    }
    return { tone: "warn", label: "Signature valid — no server receipt on file", detail: "The signature checks out, but no matching receipt was found (it may have predated receipts or been pruned)." } as const;
  })();

  const toneClass = verdict?.tone === "good"
    ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
    : verdict?.tone === "warn"
      ? "border-amber-500/60 bg-amber-500/10 text-amber-300"
      : "border-red-500/60 bg-red-500/10 text-red-300";

  return (
    <div className="space-y-3 text-xs">
      <p className="text-keep-muted">
        Paste a submitted chat log, or drop the exported <code>.html</code> file. The log is checked against the server: a green result means it is authentic and unaltered. Editing any part of a log breaks the check.
      </p>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) readFile(file);
        }}
        className={`rounded border border-dashed p-3 ${dragOver ? "border-keep-accent bg-keep-banner/40" : "border-keep-rule"}`}
      >
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value.slice(0, MAX_CHARS)); setResult(null); }}
          placeholder="Drop the exported log here, or paste its contents…"
          spellCheck={false}
          className="h-32 w-full resize-y rounded border border-keep-rule bg-keep-bg p-2 font-mono text-[11px] text-keep-text"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void verify()}
            disabled={busy}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 hover:bg-keep-banner/60 disabled:opacity-50"
          >
            {busy ? "Verifying…" : "Verify"}
          </button>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 hover:bg-keep-banner/60"
          >
            Choose file…
          </button>
          {text ? (
            <button
              type="button"
              onClick={() => { setText(""); setResult(null); setError(null); }}
              className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 hover:bg-keep-banner/60"
            >
              Clear
            </button>
          ) : null}
          <input
            ref={fileInput}
            type="file"
            accept=".html,text/html,application/json,text/plain"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ""; }}
          />
        </div>
      </div>

      {error ? (
        <div className="rounded border border-red-500/60 bg-red-500/10 p-2 text-red-300">{error}</div>
      ) : null}

      {verdict ? (
        <div className={`rounded border p-3 ${toneClass}`}>
          <div className="font-semibold">{verdict.label}</div>
          {verdict.detail ? <div className="mt-1 text-[11px] opacity-90">{verdict.detail}</div> : null}
        </div>
      ) : null}

      {result?.meta ? (
        <fieldset className="rounded border border-keep-rule p-3">
          <legend className="px-1 uppercase tracking-widest text-keep-muted">Export details</legend>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            <Field label="Verification ID" value={result.receiptId ?? "—"} mono />
            <Field label="Room" value={result.meta.roomName} />
            <Field label="Exported by" value={result.meta.exportedByUsername} />
            <Field label="Generated" value={fmtTime(result.meta.generatedAtMs)} />
            <Field label="Range start" value={fmtTime(result.meta.rangeStartMs)} />
            <Field label="Range end" value={fmtTime(result.meta.rangeEndMs)} />
            <Field label="Messages" value={String(result.meta.messageCount)} />
            <Field label="Older lines dropped" value={result.meta.truncated ? "yes (cap reached)" : "no"} />
            <Field
              label="Server receipt"
              value={result.stored?.exists ? (result.stored.matchesHash ? "found, matches" : "found, MISMATCH") : "not found"}
            />
          </div>
        </fieldset>
      ) : null}

      {result?.valid && result.messages && result.messages.length > 0 ? (
        <fieldset className="rounded border border-keep-rule p-3">
          <legend className="px-1 uppercase tracking-widest text-keep-muted">Signed messages ({result.messages.length})</legend>
          <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
            {result.messages.map((m) => (
              <div key={m.id} className="border-t border-keep-rule pt-2 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-baseline gap-2 text-[11px] text-keep-muted">
                  <span className="font-mono tabular-nums">{fmtTime(m.createdAt)}</span>
                  <span className="font-semibold text-keep-text" style={m.color ? { color: m.color } : undefined}>
                    {m.displayName}
                  </span>
                  {m.kind !== "say" ? <span className="rounded border border-keep-rule px-1 uppercase tracking-wider">{m.kind}</span> : null}
                  {m.toDisplayName ? <span>→ {m.toDisplayName}</span> : null}
                  {m.moodSnapshot ? <span className="italic">({m.moodSnapshot})</span> : null}
                  {m.npcVoicedBy ? <span>voiced by {m.npcVoicedBy}</span> : null}
                </div>
                {/* Plain text — React escapes it; never dangerouslySetInnerHTML here. */}
                <div className="whitespace-pre-wrap break-words text-keep-text">{m.body}</div>
              </div>
            ))}
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-keep-muted">{label}</span>
      <span className={`text-keep-text ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
