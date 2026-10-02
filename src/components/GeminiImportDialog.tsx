/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { useEffect, useMemo, useRef, useState } from "react";
import { convertGeminiJson } from "../lib/geminiImport";
import { addAudioFiles } from "../lib/fileHandlers";
import { saveSongTiming } from "../lib/timing";
import { extractLocalSunoAudio } from "../lib/localSuno";
import { useStore } from "../lib/store";
import { getBaseName } from "../lib/utils";

export interface GeminiImportDraft {
  text: string;
  name: string;
  lyrics: string;
  media: File[];
}

function mediaDuration(file: File, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    const finish = (error?: Error) => {
      const duration = audio.duration;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      audio.onloadedmetadata = null; audio.onerror = null;
      audio.removeAttribute("src"); audio.load(); URL.revokeObjectURL(url);
      if (error || !Number.isFinite(duration) || duration <= 0) reject(error || new Error("Could not read the audio duration."));
      else resolve(duration);
    };
    const abort = () => finish(new Error("Import canceled."));
    const timer = window.setTimeout(() => finish(new Error("Could not read this audio. Try an M4A, MP3 or WAV file.")), 15_000);
    signal.addEventListener("abort", abort, { once: true });
    audio.onloadedmetadata = () => finish();
    audio.onerror = () => finish(new Error("Could not read this audio. Try an M4A, MP3 or WAV file."));
    audio.preload = "metadata";
    if (signal.aborted) abort(); else audio.src = url;
  });
}

export function GeminiImportDialog({ draft, onClose, onImported }: {
  draft: GeminiImportDraft;
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const songs = useStore(state => state.audioFiles);
  const [text, setText] = useState(draft.text);
  const [lyrics, setLyrics] = useState(draft.lyrics);
  const [media, setMedia] = useState(draft.media);
  const [target, setTarget] = useState(draft.media.length === 1 ? "file:0" : useStore.getState().selectedAudioId || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const file = target.startsWith("file:") ? media[Number(target.slice(5))] : undefined;
  const song = songs.find(s => s.id === target);
  const title = getBaseName(file?.name || song?.name || draft.name);
  const conversion = useMemo(() => {
    try { return { result: convertGeminiJson(text, { lyrics, title }), error: "" }; }
    catch (error) { return { result: null, error: (error as Error).message }; }
  }, [text, lyrics, title]);

  useEffect(() => {
    dialog.current?.showModal();
    return () => controller.current?.abort();
  }, []);

  const download = () => {
    if (!conversion.result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(conversion.result, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${title.replace(/[<>:"/\\|?*]/g, "_")}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const apply = async () => {
    if (!conversion.result || busy) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true); setError("");
    try {
      let audio = file || song?.file;
      if (!audio) throw new Error("Choose the song's audio, or a Suno video in the local app.");
      if (audio.type.startsWith("video/") || /\.(mp4|mkv|mov)$/i.test(audio.name)) {
        audio = await extractLocalSunoAudio(audio, abort.signal);
      }
      const duration = await mediaDuration(audio, abort.signal);
      const timing = convertGeminiJson(text, { lyrics, title, duration });
      if (abort.signal.aborted) throw new Error("Import canceled.");
      const targetSong = file ? (await addAudioFiles([audio]))[0] : song;
      if (!targetSong) throw new Error("Choose a song before importing.");
      await saveSongTiming(targetSong.id, JSON.stringify(timing, null, 2));
      onImported(`Gemini lyrics added: ${timing.reviewNotes.timedEntries} timed entries in ${timing.segments.length} bilingual cues. Original word timings preserved.`);
    } catch (error) {
      setError(abort.signal.aborted ? "Import canceled." : (error as Error).message);
    } finally { controller.current = null; setBusy(false); }
  };

  return <dialog ref={dialog} className="gemini-import-dialog" aria-labelledby="gemini-import-title"
    onCancel={event => { event.preventDefault(); if (busy) controller.current?.abort(); else onClose(); }}>
    <div className="gemini-import-heading">
      <h2 id="gemini-import-title">Import Gemini lyrics</h2>
      <button type="button" aria-label="Close Gemini import" disabled={busy} onClick={onClose}>×</button>
    </div>
    <p>Turn your Gemini export into Spanish above and sung English below. Conversion stays on this device and uses no API credits.</p>
    <fieldset disabled={busy}>
      <label>Song
        <select aria-label="Song" value={target} onChange={event => setTarget(event.target.value)}>
          <option value="">Choose a song, or download JSON only</option>
          {media.map((file, index) => <option key={index} value={`file:${index}`}>{file.name} (new file)</option>)}
          {songs.map(song => <option key={song.id} value={song.id}>{song.name}</option>)}
        </select>
      </label>
      <label className="gemini-media-input">Add audio or local Suno video
        <input type="file" accept="audio/*,video/mp4,.mp4,.mov,.mkv"
          onChange={event => {
            const picked = event.currentTarget.files?.[0];
            if (picked) { setMedia(files => [...files, picked]); setTarget(`file:${media.length}`); }
            event.currentTarget.value = "";
          }} />
      </label>
      {song?.timing && <p className="gemini-import-note">Using these lyrics will replace the current timings for {song.name}.</p>}
      <details>
        <summary>Gemini JSON · {draft.name}</summary>
        <label>Gemini JSON output<textarea value={text} onChange={event => setText(event.target.value)} rows={7} spellCheck={false} /></label>
      </details>
      <label>Suno lyrics / phrase guide (optional for labeled JSON)
        <textarea value={lyrics} onChange={event => setLyrics(event.target.value)} rows={6}
          placeholder={'Caminando por la calle (Walking down the street)\n[en] An improvised English line\n[es] Una frase improvisada'} />
      </label>
      <p className="gemini-import-note">For unlabeled words, paste the Suno lyrics: Spanish outside parentheses, English inside. Add improvised phrases with [es] or [en]. Only words already in the JSON are used.</p>
    </fieldset>
    {conversion.error && <p className="gemini-import-error" role="alert">{conversion.error}</p>}
    {conversion.result && <div className="gemini-import-preview" aria-label="Conversion preview">
      <strong>{conversion.result.reviewNotes.timedEntries} timed entries · {conversion.result.segments.length} {conversion.result.segments.length === 1 ? "cue" : "cues"}</strong>
      <p>{conversion.result.reviewNotes.spanishEntries} Spanish · {conversion.result.reviewNotes.englishEntries} English · {conversion.result.reviewNotes.uncertainEntries} uncertain</p>
      <p>Word timings stay unchanged. Listen to check the result.</p>
      {!!conversion.result.reviewNotes.placeholders.length && <p>{conversion.result.reviewNotes.placeholders.length} punctuation-only entries kept in review notes.</p>}
      {!!conversion.result.reviewNotes.combinedEntries.length && <p>{conversion.result.reviewNotes.combinedEntries.length} combined word entries keep their supplied spans.</p>}
      {!!conversion.result.reviewNotes.inferredPhraseCount && <p>Some phrase breaks were inferred. Add phrase_id to each word for exact grouping.</p>}
    </div>}
    {error && <p role="alert" className="gemini-import-error">{error}</p>}
    <div className="gemini-import-actions">
      <button type="button" disabled={!conversion.result || busy} onClick={download}>Download timing JSON</button>
      <button type="button" disabled={!conversion.result || !target || busy} onClick={() => void apply()}>{busy ? "Importing…" : "Use lyrics"}</button>
      <button type="button" onClick={() => busy ? controller.current?.abort() : onClose()}>{busy ? "Cancel import" : "Cancel"}</button>
    </div>
  </dialog>;
}
