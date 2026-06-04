/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import assert from "node:assert/strict";
import {
  filterYoutubeCaptionTracksForPolicy,
  getYoutubeCaptionPolicy,
  isYoutubeAutomaticCaptionTrack,
  parseYoutubeAutomaticCaptionsOptIn,
  YOUTUBE_CAPTION_POLICY_AUTOMATIC_OPT_IN,
  YOUTUBE_CAPTION_POLICY_MANUAL_ONLY,
} from "../src/lib/youtubeCaptionPolicy";

const manualEnglish = { kind: "", vssId: ".en", name: "English" };
const automaticByKind = { kind: "asr", vssId: ".en", name: "English" };
const automaticByVssId = { kind: "", vssId: "a.fi", name: "Finnish" };
const automaticByName = { kind: "", vssId: ".es", name: "Spanish auto-generated" };

assert.equal(parseYoutubeAutomaticCaptionsOptIn(true), true);
assert.equal(parseYoutubeAutomaticCaptionsOptIn(false), false);
assert.equal(parseYoutubeAutomaticCaptionsOptIn("true"), false);
assert.equal(parseYoutubeAutomaticCaptionsOptIn(1), false);
assert.equal(parseYoutubeAutomaticCaptionsOptIn({ allow: true }), false);

assert.equal(getYoutubeCaptionPolicy(false), YOUTUBE_CAPTION_POLICY_MANUAL_ONLY);
assert.equal(getYoutubeCaptionPolicy(true), YOUTUBE_CAPTION_POLICY_AUTOMATIC_OPT_IN);

assert.equal(isYoutubeAutomaticCaptionTrack(manualEnglish), false);
assert.equal(isYoutubeAutomaticCaptionTrack(automaticByKind), true);
assert.equal(isYoutubeAutomaticCaptionTrack(automaticByVssId), true);
assert.equal(isYoutubeAutomaticCaptionTrack(automaticByName), true);

assert.deepEqual(
  filterYoutubeCaptionTracksForPolicy([manualEnglish, automaticByKind, automaticByVssId, automaticByName], false),
  [manualEnglish],
);

assert.deepEqual(
  filterYoutubeCaptionTracksForPolicy([manualEnglish, automaticByKind, automaticByVssId, automaticByName], true),
  [manualEnglish, automaticByKind, automaticByVssId, automaticByName],
);

console.log("youtube caption policy smoke ok");
