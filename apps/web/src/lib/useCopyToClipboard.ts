import { useState } from "react";

export interface UseCopyToClipboardOptions {
  /**
   * How long the `copied` flag stays true after a successful copy, in ms.
   * @default 1500
   */
  resetMs?: number;
  /**
   * Called with the attempted text when the clipboard write fails
   * (permission denied / insecure context / no Clipboard API). Lets a caller
   * surface a manual-copy fallback (e.g. `window.prompt`). Omit to fail
   * silently.
   */
  onError?: (text: string) => void;
}

/**
 * Copy-to-clipboard with a transient "copied" flash. Consolidates the pattern
 * that was hand-duplicated across the app: write text to the clipboard, flip a
 * `copied` flag true, then reset it to false after `resetMs`. On failure it
 * invokes `onError` (if given) so callers can drop a manual-copy fallback.
 *
 * Behavior note: matching the original inline copies, this does NOT cancel an
 * in-flight reset timer on a repeat copy or on unmount.
 */
export function useCopyToClipboard(options: UseCopyToClipboardOptions = {}) {
  const { resetMs = 1500, onError } = options;
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), resetMs);
    } catch {
      onError?.(text);
    }
  };
  return { copied, copy };
}
