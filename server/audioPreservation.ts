import { spawn } from "node:child_process";
import path from "node:path";
import ffmpeg from "ffmpeg-static";

export const ffmpegPath = () => process.env.FFMPEG_PATH || ffmpeg || "ffmpeg";

/** Inspect only the first audio stream, exactly the stream selected by import/export. */
export async function firstAudioCodec(input: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-nostdin", "-hide_banner", "-protocol_whitelist", "file,pipe", "-i", input],
      { windowsHide: true, signal, timeout: 10_000, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = "";
    child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-64_000); });
    child.once("error", reject);
    child.once("close", () => {
      // ffmpeg's probe exits nonzero when no output is requested; parse the stream, not the exit status.
      const codec = diagnostic.match(/Stream #[^\r\n]+Audio:\s*([\w]+)/)?.[1];
      if (codec) resolve(codec); else reject(new Error("No readable audio track in this file."));
    });
  });
}

export function extractionFormat(codec: string) {
  const copied: Record<string, { extension: string; mimeType: string }> = {
    aac: { extension: "m4a", mimeType: "audio/mp4" },
    mp3: { extension: "mp3", mimeType: "audio/mpeg" },
    flac: { extension: "flac", mimeType: "audio/flac" },
    opus: { extension: "ogg", mimeType: "audio/ogg" },
    vorbis: { extension: "ogg", mimeType: "audio/ogg" },
  };
  if (copied[codec]) return { ...copied[codec], encoder: "copy" };
  // WAV keeps native integer/float PCM; ALAC decodes exactly into 32-bit integer PCM.
  const pcm = ["pcm_u8", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_f64le"].includes(codec)
    ? codec : codec === "alac" ? "pcm_s32le" : "pcm_f64le";
  return { extension: "wav", mimeType: "audio/wav", encoder: pcm };
}

export async function extractPreservedAudio(input: string, directory: string, signal?: AbortSignal) {
  const codec = await firstAudioCodec(input, signal);
  const format = extractionFormat(codec);
  const output = path.join(directory, `preserved.${format.extension}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file,pipe",
      "-i", input, "-map", "0:a:0", "-vn", "-map_metadata", "-1", "-c:a", format.encoder, output],
      { windowsHide: true, signal, timeout: 3 * 60_000, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = "";
    child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-3000); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`Audio preservation failed: ${diagnostic.trim()}`)));
  });
  return { ...format, output };
}

/** Container choice follows audio preservation, independently of video compression. */
export function exportAudioPlan(codec: string, mode: "publish" | "lossless", audio: "preserve" | "aac") {
  const copy = audio === "preserve" || codec === "aac";
  const extension = mode === "lossless" || (copy && codec !== "aac") ? "mkv" : "mp4";
  return { copy, extension, args: copy ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "320k"] };
}
