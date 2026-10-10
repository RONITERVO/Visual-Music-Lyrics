export function isLoopbackApp() {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

/** Video import only extracts source audio. Lyrics are a separate, explicit step. */
export async function extractLocalSunoAudio(file: File, signal?: AbortSignal): Promise<File> {
  if (!isLoopbackApp()) throw new Error("Choose an audio file here. Suno video extraction is available in the local app.");
  if (file.size > 768 * 1024 * 1024) throw new Error("Video exceeds the 768 MB import limit.");
  const response = await fetch("/api/local/suno?audioOnly=1", {
    method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Local-Import": "suno" }, body: file, signal,
  });
  const extension = response.headers.get("X-Audio-Extension");
  const mimeType = response.headers.get("Content-Type")?.split(";")[0];
  if (!response.ok || !extension || !/^(m4a|mp3|flac|ogg|wav)$/.test(extension) || !mimeType?.startsWith("audio/")) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || "Start or restart the local app with npm run dev:local to extract audio without alignment.");
  }
  const audio = await response.blob();
  if (!audio.size) throw new Error("The extracted audio is empty.");
  return new File([audio], `${file.name.replace(/\.[^.]+$/, "")}.${extension}`, { type: mimeType, lastModified: file.lastModified });
}
