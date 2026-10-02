/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { useCallback, useEffect, useRef, useState } from "react";
import { LogIn, LogOut } from "lucide-react";
import { GraphiteDesignSystem } from "./lib/graphics/GraphiteEngine";
import { useStore } from "./lib/store";
import { PlayerView } from "./components/PlayerView";
import { getDroppedFiles, TRANSCRIPT_EXTENSIONS, AUDIO_EXTENSIONS } from "./lib/fileSystem";
import { getExtension } from "./lib/utils";
import { isGeminiWordJson } from "./lib/geminiImport";
import { GeminiImportDialog, type GeminiImportDraft } from "./components/GeminiImportDialog";
import { handleGlobalDroppedFiles, loadSongSegments } from "./lib/fileHandlers";
import { restorePersistedLibrary, persistLibrary, loadSettings, saveSettings } from "./lib/persistence";
import { fetchBackendHealth, shouldUseHostedBackend } from "./lib/api";
import {
  isFirebaseConfigured,
  onFirebaseAuthStateChanged,
  signInWithGoogle,
  signOutFirebase,
  type FirebaseUser,
} from "./lib/firebase";

const BACKEND_HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;
const BACKEND_WARMUP_TIMEOUT_MS = 75_000;
const BACKEND_WARMUP_REQUEST_TIMEOUT_MS = 20_000;
const BACKEND_WARMUP_RETRY_DELAY_MS = 2_500;

function getBackendWarmMessage(attempt: number) {
  if (attempt > 1) {
    return "Still preparing media services.";
  }

  return "Preparing media services before song upload.";
}

function getBackendErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Could not reach the backend.";
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      window.clearTimeout(timeoutId);
      resolve();
    };

    if (signal.aborted) {
      window.clearTimeout(timeoutId);
      resolve();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchBackendHealthWithTimeout(signal: AbortSignal) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), BACKEND_WARMUP_REQUEST_TIMEOUT_MS);
  const abortRelay = () => controller.abort();

  signal.addEventListener("abort", abortRelay, { once: true });

  try {
    return await fetchBackendHealth(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) {
      throw new Error("Timed out waiting for the backend to wake up.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    signal.removeEventListener("abort", abortRelay);
  }
}

async function waitForBackendReady(signal: AbortSignal, onAttempt: (attempt: number) => void) {
  const startedAt = Date.now();
  let attempt = 0;
  let lastError: unknown = null;

  while (!signal.aborted) {
    attempt += 1;
    onAttempt(attempt);

    try {
      await fetchBackendHealthWithTimeout(signal);
      return;
    } catch (error) {
      if (signal.aborted) return;
      lastError = error;

      if (Date.now() - startedAt >= BACKEND_WARMUP_TIMEOUT_MS) {
        break;
      }

      await sleep(BACKEND_WARMUP_RETRY_DELAY_MS, signal);
    }
  }

  if (!signal.aborted) {
    throw lastError || new Error("Could not reach the backend.");
  }
}

export default function App() {
  const backendSessionEnabled = shouldUseHostedBackend();
  const authEnabled = isFirebaseConfigured();
  const [authReady, setAuthReady] = useState(!authEnabled);
  const [authUser, setAuthUser] = useState<FirebaseUser | null>(null);
  const [authError, setAuthError] = useState("");
  const [isAuthBypassed, setIsAuthBypassed] = useState(() => {
    return typeof window !== "undefined" && window.localStorage.getItem("local_auth_bypass") === "true";
  });
  const [isDragging, setIsDragging] = useState(false);
  const [backendWarmState, setBackendWarmState] = useState<"warming" | "ready" | "error">(
    backendSessionEnabled ? "warming" : "ready"
  );
  const [backendWarmMessage, setBackendWarmMessage] = useState(
    backendSessionEnabled ? getBackendWarmMessage(1) : ""
  );
  const [backendWarmNonce, setBackendWarmNonce] = useState(0);
  const canAcceptDropsRef = useRef(true);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const mediaAbortRef = useRef<AbortController | null>(null);
  const [mediaImportMessage, setMediaImportMessage] = useState("");
  const [mediaImportBusy, setMediaImportBusy] = useState(false);
  const [geminiImport, setGeminiImport] = useState<GeminiImportDraft | null>(null);
  const isAuthBlocked = authEnabled && !isAuthBypassed && (!authReady || !authUser);

  const importMedia = useCallback(async (files: File[]) => {
    if (!files.length || mediaAbortRef.current || !canAcceptDropsRef.current) return;
    const controller = new AbortController();
    mediaAbortRef.current = controller;
    setMediaImportBusy(true);
    const hasVideo = files.some(file => file.type.startsWith("video/") || /\.(mp4|mkv|mov)$/i.test(file.name));
    setMediaImportMessage(hasVideo ? "Importing video and checking supplied lyric timings…" : "Adding songs and lyrics…");
    try {
      const documents = await Promise.all(files.filter(file => TRANSCRIPT_EXTENSIONS.has(getExtension(file.name)))
        .map(async file => {
          if (file.size > 5 * 1024 * 1024) throw new Error("Timing files must be under 5 MB.");
          return { file, text: await file.text() };
        }));
      const gemini = documents.filter(item => isGeminiWordJson(item.text));
      if (gemini.length > 1) throw new Error("Import one Gemini song at a time so you can choose its audio and phrase guide.");
      if (gemini.length) {
        const guides = documents.filter(item => item !== gemini[0] && /^(txt|text|lyrics)$/.test(getExtension(item.file.name)));
        setGeminiImport({ text: gemini[0].text, name: gemini[0].file.name, lyrics: guides.length === 1 ? guides[0].text : "",
          media: files.filter(file => file.type.startsWith("audio/") || file.type.startsWith("video/") || AUDIO_EXTENSIONS.has(getExtension(file.name)) || getExtension(file.name) === "mov"),
        });
        setMediaImportMessage("");
        return;
      }
      const result = await handleGlobalDroppedFiles(files, controller.signal);
      const first = result.addedSongs.find((song: any) => song.file && song.url);
      const state = useStore.getState();
      const id = first?.id || state.selectedAudioId || state.audioFiles[0]?.id;
      if (id) await loadSongSegments(id);
      setMediaImportMessage(result.alignedVideos
        ? "Audio and bilingual lyrics added. Review the machine-aligned text and timing before publishing."
        : result.reusedVideoTimings ? "Audio and supplied lyrics added. OCR and Whisper were skipped."
        : result.audioFiles.length || result.transcriptFiles.length ? "Files added." : "Choose audio, a Suno video, or a timing JSON, LRC, SRT or VTT file.");
    } catch (error) {
      setMediaImportMessage(controller.signal.aborted ? "Import canceled." : getBackendErrorMessage(error));
    } finally {
      mediaAbortRef.current = null;
      setMediaImportBusy(false);
    }
  }, []);

  useEffect(() => {
    canAcceptDropsRef.current = !isAuthBlocked && !geminiImport;
  }, [isAuthBlocked, geminiImport]);

  useEffect(() => {
    if (!authEnabled) return;

    setAuthReady(false);
    return onFirebaseAuthStateChanged((user) => {
      setAuthUser(user);
      setAuthReady(true);
      setAuthError("");
    });
  }, [authEnabled]);

  const handleSignIn = async () => {
    setAuthError("");
    try {
      await signInWithGoogle();
    } catch (error: any) {
      setAuthError(String(error?.message || error || "Google sign-in failed."));
    }
  };

  const handleSignOut = async () => {
    setAuthError("");
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("local_auth_bypass");
    }
    setIsAuthBypassed(false);
    try {
      await signOutFirebase();
    } catch (error: any) {
      setAuthError(String(error?.message || error || "Sign-out failed."));
    }
  };

  useEffect(() => {
    if (!backendSessionEnabled) {
      setBackendWarmState("ready");
      setBackendWarmMessage("");
      return;
    }

    const controller = new AbortController();
    let heartbeatId = 0;
    let isWarming = false;

    const warmBackend = async (showOverlay = true) => {
      if (controller.signal.aborted || isWarming) return;
      isWarming = true;
      if (showOverlay) {
        setBackendWarmState("warming");
      }

      try {
        await waitForBackendReady(controller.signal, (attempt) => {
          setBackendWarmMessage(getBackendWarmMessage(attempt));
        });

        if (controller.signal.aborted) return;
        setBackendWarmState("ready");
        setBackendWarmMessage("");
      } catch (error) {
        if (controller.signal.aborted) return;
        setBackendWarmState("error");
        setBackendWarmMessage(getBackendErrorMessage(error));
      } finally {
        isWarming = false;
      }
    };

    const recheckBackend = async () => {
      if (controller.signal.aborted) return;

      try {
        await fetchBackendHealthWithTimeout(controller.signal);
        if (controller.signal.aborted) return;
        setBackendWarmState("ready");
        setBackendWarmMessage("");
      } catch {
        await warmBackend(true);
      }
    };

    const handleVisibilityReturn = () => {
      if (document.visibilityState === "visible") {
        void recheckBackend();
      }
    };

    void warmBackend(true);
    heartbeatId = window.setInterval(() => {
      void recheckBackend();
    }, BACKEND_HEARTBEAT_INTERVAL_MS);

    document.addEventListener("visibilitychange", handleVisibilityReturn);
    window.addEventListener("focus", handleVisibilityReturn);

    return () => {
      controller.abort();
      window.clearInterval(heartbeatId);
      document.removeEventListener("visibilitychange", handleVisibilityReturn);
      window.removeEventListener("focus", handleVisibilityReturn);
    };
  }, [backendSessionEnabled, backendWarmNonce]);

  useEffect(() => {
    const engine = new GraphiteDesignSystem();
    engine.init();
    
    useStore.setState(loadSettings());
    restorePersistedLibrary();

    const unsub = useStore.subscribe((state, prevState) => {
      if (state.audioFiles !== prevState.audioFiles) {
        persistLibrary().catch(console.error);
      }

      if (
        state.sourceLanguage !== prevState.sourceLanguage ||
        state.targetLanguage !== prevState.targetLanguage ||
        state.translationEnabled !== prevState.translationEnabled ||
        state.allowAutomaticYoutubeCaptions !== prevState.allowAutomaticYoutubeCaptions
      ) {
        saveSettings(state);
      }
    });

    let dragDepth = 0;
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      if (!canAcceptDropsRef.current) return;
      dragDepth++;
      setIsDragging(true);
    };
    
    const handleDragOver = (e: DragEvent) => e.preventDefault();
    
    const handleDragLeave = (e: DragEvent) => {
      if (!canAcceptDropsRef.current) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setIsDragging(false);
    };
    
    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      dragDepth = 0;
      setIsDragging(false);

      if (!canAcceptDropsRef.current) return;
      
      if (!e.dataTransfer) return;
      const files = await getDroppedFiles(e.dataTransfer);
      await importMedia(files);
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);

    return () => {
      mediaAbortRef.current?.abort();
      unsub();
      engine.destroy();
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
    };
  }, []);

  return (
    <>
      <PlayerView onImportGemini={!isAuthBlocked && !mediaImportBusy ? () => setGeminiImport({ text: "", name: "Gemini lyrics", lyrics: "", media: [] }) : undefined} />
      {geminiImport && <GeminiImportDialog draft={geminiImport} onClose={() => setGeminiImport(null)}
        onImported={message => { setGeminiImport(null); setMediaImportMessage(message); }} />}
      {!isAuthBlocked && <>
        <button className="media-picker" type="button" disabled={mediaImportBusy} onClick={() => mediaInputRef.current?.click()}>
          {mediaImportBusy ? "Importing…" : "Add songs"}
        </button>
        <input ref={mediaInputRef} hidden type="file" multiple aria-label="Add audio, Suno video or lyric timing files"
          accept="audio/*,video/mp4,video/webm,.mkv,.mov,.json,.lrc,.srt,.vtt,.txt"
          onChange={event => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ""; void importMedia(files); }} />
      </>}
      {mediaImportMessage && <div role="status" className="media-import-status">
        {mediaImportMessage}
        <button type="button" onClick={() => mediaImportBusy ? mediaAbortRef.current?.abort() : setMediaImportMessage("")}>
          {mediaImportBusy ? "Cancel" : "Dismiss"}
        </button>
      </div>}

      {authEnabled && authReady && authUser && (
        <div className="fixed right-3 top-3 z-[90] flex max-w-[min(420px,calc(100vw-1.5rem))] items-center gap-2 rounded-[8px] border border-ink-graphite/15 bg-paper-light/95 px-3 py-2 text-ink-graphite shadow-lg backdrop-blur-md">
          {authUser.photoURL && (
            <img
              src={authUser.photoURL}
              alt=""
              className="h-7 w-7 rounded-full border border-ink-graphite/15"
              referrerPolicy="no-referrer"
            />
          )}
          <span className="min-w-0 flex-1 truncate font-body text-[0.88rem]">
            {authUser.displayName || authUser.email || "Signed in"}
          </span>
          <button
            type="button"
            className="grid h-8 w-8 place-items-center rounded-[6px] text-ink-graphite-light transition hover:bg-ink-blueprint/10 hover:text-ink-blueprint"
            title="Sign out"
            onClick={handleSignOut}
          >
            <LogOut size={17} />
          </button>
        </div>
      )}

      {backendSessionEnabled && !isAuthBypassed && backendWarmState !== "ready" && (
        <div className="fixed inset-0 z-[110] grid place-items-center bg-black/65 backdrop-blur-sm">
          <div className="grid w-[min(460px,92vw)] gap-4 rounded-2xl border border-ink-blueprint/30 bg-paper-light/95 p-6 text-center text-ink-graphite shadow-2xl">
            <div className="mx-auto h-11 w-11 rounded-full border-4 border-ink-blueprint/20 border-t-ink-blueprint animate-spin" />
            <div className="grid gap-2">
              <strong className="font-display text-[2.1rem] leading-none text-ink-blueprint">
                {backendWarmState === "error" ? "Backend unavailable" : "Waking backend"}
              </strong>
              <span className="font-body text-[1rem] leading-6 text-ink-graphite-light">
                {backendWarmState === "error"
                  ? backendWarmMessage
                  : backendWarmMessage}
              </span>
              <span className="font-body text-[0.92rem] leading-6 text-ink-graphite-light">
                The app will keep checking readiness while this tab stays open.
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3">
              {backendWarmState === "error" && (
                <button
                  type="button"
                  className="rounded-full border border-ink-blueprint/30 px-4 py-2 font-body text-[0.95rem] text-ink-blueprint transition hover:bg-ink-blueprint/10"
                  onClick={() => setBackendWarmNonce((value) => value + 1)}
                >
                  Retry backend wake-up
                </button>
              )}
              <button
                type="button"
                className="rounded-full bg-ink-blueprint/15 px-4 py-2 font-body text-[0.95rem] text-ink-blueprint transition hover:bg-ink-blueprint/25"
                onClick={() => {
                  setIsAuthBypassed(true);
                  if (typeof window !== "undefined") {
                    window.localStorage.setItem("local_auth_bypass", "true");
                  }
                }}
              >
                Continue Offline / Local Mode
              </button>
            </div>
          </div>
        </div>
      )}

      {authEnabled && isAuthBlocked && (
        <div className="fixed inset-0 z-[120] grid place-items-center bg-black/70 px-4 backdrop-blur-sm">
          <div className="grid w-[min(420px,92vw)] gap-4 rounded-[8px] border border-ink-blueprint/25 bg-paper-light/95 p-5 text-center text-ink-graphite shadow-2xl">
            <strong className="font-display text-[2rem] leading-none text-ink-blueprint">
              Sign in
            </strong>
            <span className="font-body text-[0.98rem] leading-6 text-ink-graphite-light">
              Google sign-in is required for translation, media import, and metered Scribe usage.
            </span>
            <button
              type="button"
              className="mx-auto inline-flex items-center justify-center gap-2 rounded-[8px] bg-ink-blueprint px-4 py-2 font-body text-[0.96rem] text-paper-light shadow-md transition hover:bg-ink-blueprint/90 active:scale-95"
              onClick={handleSignIn}
              disabled={!authReady}
            >
              <LogIn size={18} />
              Google
            </button>
            {authError && (
              <span className="break-words font-body text-[0.86rem] leading-5 text-ink-red">
                {authError}
              </span>
            )}
            <div className="flex flex-col items-center gap-1 border-t border-ink-graphite/10 pt-3">
              <button
                type="button"
                className="font-body text-[0.88rem] font-bold text-ink-blueprint underline transition hover:text-ink-graphite active:scale-95"
                onClick={() => {
                  if (typeof window !== "undefined") {
                    window.localStorage.setItem("local_auth_bypass", "true");
                  }
                  setIsAuthBypassed(true);
                }}
              >
                Continue in Local / Offline Mode
              </button>
              <span className="font-body text-[0.78rem] text-ink-graphite/50">
                Play local songs, drag & drop media & visual lyrics without sign-in.
              </span>
            </div>
          </div>
        </div>
      )}

      {isDragging && (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-black/60 backdrop-blur-sm pointer-events-none">
          <div className="w-[min(440px,90vw)] min-h-[200px] p-8 grid place-items-center text-center bg-paper-light/90 shadow-2xl rounded-2xl border-2 border-dashed border-ink-blueprint">
            <strong className="font-display text-[2.5rem] text-ink-blueprint leading-tight">Drop media or lyrics</strong>
            <span className="text-ink-graphite-light font-body text-base mt-2">Audio, video, or timing JSON will be synced immediately</span>
          </div>
        </div>
      )}
    </>
  );
}
