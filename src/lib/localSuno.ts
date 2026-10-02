export function isLoopbackApp() {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

/** Gemini already supplied the lyrics: only extract audio, without OCR/Whisper. */
export async function extractLocalSunoAudio(file: File, signal?: AbortSignal): Promise<File> {
  if (!isLoopbackApp()) throw new Error("Choose an audio file here. Suno video extraction is available in the local app.");
  if (file.size > 100 * 1024 * 1024) throw new Error("Video exceeds the 100 MB import limit.");
  const response = await fetch("/api/local/suno?audioOnly=1", {
    method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Local-Import": "suno" }, body: file, signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.audioBase64 || data.timing) {
    throw new Error(data?.error || "Start or restart the local app with npm run dev:local to extract audio without alignment.");
  }
  const bytes = Uint8Array.from(atob(data.audioBase64), character => character.charCodeAt(0));
  return new File([bytes], `${file.name.replace(/\.[^.]+$/, "")}.m4a`, { type: "audio/mp4", lastModified: file.lastModified });
}

export async function importLocalSuno(file: File, signal?: AbortSignal) {
  if (!isLoopbackApp()) throw new Error("Import Suno videos in the local app. On this site, add the exported audio and timing JSON.");
  if (file.size > 100 * 1024 * 1024) throw new Error("Video exceeds the 100 MB import limit.");
  const response = await fetch("/api/local/suno", {
    method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Local-Import": "suno" }, body: file, signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.audioBase64 || !data?.timing?.segments?.length) {
    throw new Error(data?.error || "Start the local app with LOCAL_MEDIA_IMPORT=true and configure the local lyric model. See README → Local Suno import.");
  }
  const base = file.name.replace(/\.[^.]+$/, "");
  const bytes = Uint8Array.from(atob(data.audioBase64), character => character.charCodeAt(0));
  return {
    audio: new File([bytes], `${base}.m4a`, { type: "audio/mp4", lastModified: file.lastModified }),
    timing: new File([JSON.stringify({ ...data.timing, title: base })], `${base}.json`, { type: "application/json" }),
  };
}
