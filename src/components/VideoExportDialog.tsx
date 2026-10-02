import { useEffect, useRef, useState } from "react";
import type { MusicLyricTheme, Segment } from "../types";
import { exportVideo, removeVideoExport, type VideoExportProgress } from "../lib/video/exportVideo";
import { isLoopbackApp } from "../lib/localSuno";
import { getBaseName } from "../lib/utils";

export function VideoExportDialog({ song, segments, theme, onClose, onBusyChange }: {
  song: { file: File; name: string }; segments: Segment[]; theme: MusicLyricTheme;
  onClose: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<"publish" | "lossless">("publish");
  const [size, setSize] = useState(720);
  const [aspect, setAspect] = useState("portrait");
  const [progress, setProgress] = useState<VideoExportProgress | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof exportVideo>> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); return () => controller.current?.abort(); }, []);
  const start = async () => {
    setError(""); setBusy(true); onBusyChange(true);
    const abort = new AbortController(); controller.current = abort;
    try {
      if (result) { await removeVideoExport(result.id); setResult(null); }
      const tall = size === 720 ? 1280 : 1920;
      const video = await exportVideo({ file: song.file, title: getBaseName(song.name), segments, theme, mode,
        width: aspect === "landscape" ? tall : size, height: aspect === "portrait" ? tall : size, fps: 30,
      }, abort.signal, setProgress);
      setResult(video);
    } catch (error) { setError(abort.signal.aborted ? "Export canceled." : (error as Error).message); }
    finally { controller.current = null; setBusy(false); onBusyChange(false); }
  };
  return <dialog ref={dialog} className="gemini-import-dialog video-export-dialog" data-control="true" aria-labelledby="video-export-title"
    onCancel={event => { event.preventDefault(); if (busy) controller.current?.abort(); else onClose(); }}>
    <div className="gemini-import-heading"><h2 id="video-export-title">Export video</h2>
      <button type="button" aria-label="Close video export" disabled={busy} onClick={onClose}>×</button></div>
    <p>{getBaseName(song.name)} · {theme === "sketchbook" ? "Living Sketchbook" : "Signal Bloom"}</p>
    <p>Render the full song with its audio, word-by-word lyrics, and timer. No need to play through it; speed depends on your computer.</p>
    {!isLoopbackApp() && <p role="alert">Fast export runs in the local desktop app. Open your library there to export.</p>}
    <fieldset disabled={busy}>
      <label>Video format<select aria-label="Video format" value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
        <option value="publish">Publishing MP4 · high quality</option><option value="lossless">Lossless master · MKV</option>
      </select></label>
      <p className="gemini-import-note">{mode === "publish"
        ? "H.264 video for sharing. High quality, not mathematically lossless. AAC audio is copied; other audio is converted to AAC."
        : "Preserves rendered RGB pixels and copies the original audio stream. Larger files; use MP4 for broad publishing compatibility."}</p>
      <label>Shape<select aria-label="Video shape" value={aspect} onChange={e => setAspect(e.target.value)}>
        <option value="portrait">Portrait · 9:16</option><option value="landscape">Landscape · 16:9</option><option value="square">Square · 1:1</option>
      </select></label>
      <label>Resolution<select aria-label="Video resolution" value={size} onChange={e => setSize(Number(e.target.value))}>
        <option value={720}>720p · faster</option><option value={1080}>1080p · sharper</option>
      </select></label>
      <p className="gemini-import-note">30 fps · local processing · no API credits</p>
    </fieldset>
    {progress && <div className="gemini-import-preview" role="status">
      <strong>{progress.phase}</strong>
      {progress.total > 0 && <><progress max={progress.total} value={progress.frames} style={{ width: "100%" }} />
        <p>{Math.round(progress.frames / progress.total * 100)}% · {Math.round(progress.elapsed)} seconds elapsed</p></>}
    </div>}
    {error && <p role="alert" className="gemini-import-error">{error}</p>}
    {result && <div className="gemini-import-preview">
      <p>Rendered {Math.round(result.duration)} seconds in {Math.round(result.elapsed)} seconds ({(result.duration / result.elapsed).toFixed(1)}× playback speed).</p>
      <a href={result.url} download={`${getBaseName(song.name)}.${result.extension}`} className="video-download-link">Download {result.extension.toUpperCase()}</a>
      <p className="gemini-import-note">Download within 10 minutes. The source song stays in your library.</p>
    </div>}
    <div className="gemini-import-actions">
      <button type="button" disabled={busy || !isLoopbackApp()} onClick={() => void start()}>{result ? "Export again" : "Export video"}</button>
      <button type="button" onClick={() => busy ? controller.current?.abort() : onClose()}>{busy ? "Cancel export" : "Close"}</button>
    </div>
  </dialog>;
}
