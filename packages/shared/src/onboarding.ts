/**
 * Per-server onboarding config — stored as JSON on
 * `server_settings.onboarding_config_json` (migration 0320) and gated by
 * `onboarding_enabled`. A new member answers a set of prompts on join; each
 * chosen option maps to a self-role usergroup (member_selectable groups from
 * migration 0320). The feature team owns the join-flow UX; this is just the
 * persisted/serialized shape read back through getServerSettings.
 */

/** One selectable answer within a prompt, mapping to a usergroup to grant. */
export interface OnboardingOption {
  /** Member-facing label for this choice. */
  label: string;
  /** The server usergroup granted when this option is chosen. */
  usergroupId: string;
}

/** One question the new member answers during onboarding. */
export interface OnboardingPrompt {
  /** Stable id for the prompt (client keying + answer mapping). */
  id: string;
  /** Member-facing question label. */
  label: string;
  /** Optional helper text shown under the label. */
  help?: string;
  /** `single` = pick one option; `multi` = pick any number. */
  kind: "single" | "multi";
  options: OnboardingOption[];
}

/** The full onboarding flow for a server. */
export interface OnboardingConfig {
  prompts: OnboardingPrompt[];
}
