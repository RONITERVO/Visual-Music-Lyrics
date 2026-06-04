/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

export const YOUTUBE_CAPTION_POLICY_MANUAL_ONLY = "manual-only";
export const YOUTUBE_CAPTION_POLICY_AUTOMATIC_OPT_IN = "automatic-opt-in";

export type YoutubeCaptionPolicy =
  | typeof YOUTUBE_CAPTION_POLICY_MANUAL_ONLY
  | typeof YOUTUBE_CAPTION_POLICY_AUTOMATIC_OPT_IN;

export interface YoutubeCaptionTrackPolicyInput {
  kind?: unknown;
  vssId?: unknown;
  name?: unknown;
}

export function parseYoutubeAutomaticCaptionsOptIn(value: unknown) {
  return value === true;
}

export function getYoutubeCaptionPolicy(allowAutomaticCaptions: boolean): YoutubeCaptionPolicy {
  return allowAutomaticCaptions
    ? YOUTUBE_CAPTION_POLICY_AUTOMATIC_OPT_IN
    : YOUTUBE_CAPTION_POLICY_MANUAL_ONLY;
}

export function isYoutubeAutomaticCaptionTrack(track: YoutubeCaptionTrackPolicyInput) {
  const kind = String(track.kind || "").trim().toLowerCase();
  const vssId = String(track.vssId || "").trim().toLowerCase();
  const name = String(track.name || "").trim().toLowerCase();

  return (
    kind === "asr" ||
    vssId.startsWith("a.") ||
    /\b(auto[-\s]?generated|automatic captions?|automatically generated)\b/.test(name)
  );
}

export function filterYoutubeCaptionTracksForPolicy<T extends YoutubeCaptionTrackPolicyInput>(
  tracks: T[],
  allowAutomaticCaptions: boolean,
) {
  return allowAutomaticCaptions ? tracks.slice() : tracks.filter((track) => !isYoutubeAutomaticCaptionTrack(track));
}
