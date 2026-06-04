/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { useEffect, useRef, useState } from "react";
import { LogIn, LogOut } from "lucide-react";
import { GraphiteDesignSystem } from "./lib/graphics/GraphiteEngine";
import { useStore } from "./lib/store";
import { PlayerView } from "./components/PlayerView";
import { getDroppedFiles } from "./lib/fileSystem";
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
  const [isDragging, setIsDragging] = useState(false);
  const [backendWarmState, setBackendWarmState] = useState<"warming" | "ready" | "error">(
    backendSessionEnabled ? "warming" : "ready"
  );
  const [backendWarmMessage, setBackendWarmMessage] = useState(
    backendSessionEnabled ? getBackendWarmMessage(1) : ""
  );
  const [backendWarmNonce, setBackendWarmNonce] = useState(0);
  const canAcceptDropsRef = useRef(!backendSessionEnabled);
  const isAuthBlocked = authEnabled && (!authReady || !authUser);

  useEffect(() => {
    canAcceptDropsRef.current = (!backendSessionEnabled || backendWarmState === "ready") && !isAuthBlocked;
  }, [backendSessionEnabled, backendWarmState, isAuthBlocked]);

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
      const result = await handleGlobalDroppedFiles(files);
      const firstPlayable = result.addedSongs.find((song: any) => song.file && song.url);
      if (firstPlayable) {
        await loadSongSegments(firstPlayable.id);
      }
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);

    return () => {
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
      <PlayerView />

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

      {backendSessionEnabled && backendWarmState !== "ready" && (
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

            {backendWarmState === "error" && (
              <div className="flex justify-center">
                <button
                  type="button"
                  className="rounded-full border border-ink-blueprint/30 px-4 py-2 font-body text-[0.95rem] text-ink-blueprint transition hover:bg-ink-blueprint/10"
                  onClick={() => setBackendWarmNonce((value) => value + 1)}
                >
                  Retry backend wake-up
                </button>
              </div>
            )}
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
              className="mx-auto inline-flex items-center justify-center gap-2 rounded-[8px] bg-ink-blueprint px-4 py-2 font-body text-[0.96rem] text-paper-light transition hover:bg-ink-blueprint/90"
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
          </div>
        </div>
      )}

      {isDragging && (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-black/60 backdrop-blur-sm pointer-events-none">
          <div className="w-[min(400px,90vw)] min-h-[200px] p-8 grid place-items-center text-center bg-transparent drop-card-fx rounded-xl border-2 border-dashed border-ink-blueprint">
            <strong className="font-display text-[3rem] text-ink-blueprint">Drop audio</strong>
            <span className="text-paper-light font-body text-xl">The visualizer will take it from here</span>
          </div>
        </div>
      )}
    </>
  );
}
