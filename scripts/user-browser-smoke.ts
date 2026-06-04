/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import "dotenv/config";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const APP_URL = process.env.USER_SMOKE_APP_URL || "http://127.0.0.1:3000/";
const CHROME_PORT = Number(process.env.USER_SMOKE_CHROME_PORT || 9224);
const CHROME_HOST = `http://127.0.0.1:${CHROME_PORT}`;
const CHROME_PATH = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const FIXTURE_NAME = "release-user-smoke.wav";
const YOUTUBE_SMOKE_URL = process.env.USER_SMOKE_YOUTUBE_URL || "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const YOUTUBE_CHANNEL_SMOKE_INPUT = process.env.USER_SMOKE_YOUTUBE_CHANNEL || "@nprmusic";
const YOUTUBE_CHANNEL_EXPECTED_TITLE = process.env.USER_SMOKE_YOUTUBE_CHANNEL_TITLE || "NPR Music";
const SLOW_CHANNEL_QUERY = process.env.USER_SMOKE_SLOW_CHANNEL_QUERY || "npr music";
const SLOW_CHANNEL_KEY_INTERVAL_MS = Number(process.env.USER_SMOKE_SLOW_CHANNEL_KEY_INTERVAL_MS || 2200);
const SLOW_CHANNEL_SETTLE_MS = Number(process.env.USER_SMOKE_SLOW_CHANNEL_SETTLE_MS || 4500);
const SYNC_TIMEOUT_MS = 180_000;
const SEARCH_INPUT_SELECTOR = 'input[placeholder*="search" i], input[placeholder*="channel" i]';

type CdpHandler = (params: any) => void;

function assert(condition: any, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function escapePowerShellSingleQuoted(value: string) {
  return value.replace(/'/g, "''");
}

async function runProcess(command: string, args: string[], options: { timeoutMs?: number } = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const timeout = setTimeout(() => {
    if (child.exitCode == null && !child.killed) child.kill();
  }, options.timeoutMs || 30_000);

  const [code] = await once(child, "close") as [number | null];
  clearTimeout(timeout);
  if (code !== 0) {
    throw new Error(`${command} failed (${code}): ${stderr || stdout}`.trim());
  }
  return stdout;
}

async function generateSpeechFixture(filePath: string) {
  if (process.platform !== "win32") {
    throw new Error("The user browser smoke currently generates its speech fixture with Windows SAPI.");
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Speech",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$synth.Volume = 100",
    "$synth.Rate = -1",
    `$synth.SetOutputToWaveFile('${escapePowerShellSingleQuoted(filePath)}')`,
    "$text = 'This is a release smoke test for the living sketchbook backend. The browser is using the real application. The backend should transcribe these spoken words and save translated timing.'",
    "$synth.Speak($text)",
    "$synth.Dispose()",
  ].join("; ");

  await runProcess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { timeoutMs: 45_000 });
  const stats = fs.statSync(filePath);
  assert(stats.size > 20_000, `speech fixture is unexpectedly small (${stats.size} bytes)`);
}

class CdpClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private handlers = new Map<string, CdpHandler[]>();

  constructor(private socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      if (message.method) {
        for (const handler of this.handlers.get(message.method) || []) {
          handler(message.params);
        }
      }
    });
  }

  on(method: string, handler: CdpHandler) {
    const handlers = this.handlers.get(method) || [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  send(method: string, params: Record<string, any> = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(payload, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  close() {
    this.socket.close();
  }
}

async function fetchJson(url: string, timeoutMs = 10_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function waitFor<T>(label: string, fn: () => Promise<T | null | false>, timeoutMs: number, intervalMs = 500): Promise<T> {
  const startedAt = Date.now();
  let lastError: any = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message || lastError}` : ""}`);
}

async function waitForChromeTarget() {
  return waitFor<any>("Chrome target", async () => {
    const targets = await fetchJson(`${CHROME_HOST}/json/list`, 2_000).catch(() => null);
    return Array.isArray(targets) ? targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl) : null;
  }, 30_000);
}

async function connectCdp(wsUrl: string) {
  const socket = new WebSocket(wsUrl);
  await once(socket, "open");
  return new CdpClient(socket);
}

async function evaluate<T>(cdp: CdpClient, expression: string, options: { userGesture?: boolean } = {}): Promise<T> {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: options.userGesture === true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed";
    throw new Error(text);
  }
  return result.result?.value as T;
}

async function getBodyText(cdp: CdpClient) {
  return evaluate<string>(cdp, "document.body ? document.body.innerText : ''");
}

async function clickButtonByAriaLabel(cdp: CdpClient, label: string) {
  const rect = await evaluate<{ x: number; y: number; disabled: boolean } | null>(cdp, `
    (() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        disabled: button.disabled,
      };
    })()
  `);

  if (!rect) return false;
  assert(!rect.disabled, `${label} button is disabled`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  return true;
}

async function clickButtonByText(cdp: CdpClient, text: string) {
  const rect = await evaluate<{ x: number; y: number; disabled: boolean } | null>(cdp, `
    (() => {
      const needle = ${JSON.stringify(text)}.toLowerCase();
      const button = [...document.querySelectorAll('button')]
        .find((item) => String(item.textContent || '').toLowerCase().includes(needle));
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        disabled: button.disabled,
      };
    })()
  `);

  assert(rect, `${text} button was not found`);
  assert(!rect.disabled, `${text} button is disabled`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
}

async function setPrimaryRangeValue(cdp: CdpClient, value: number) {
  await evaluate(cdp, `
    (() => {
      const input = document.querySelector('input[type="range"]');
      if (!input) throw new Error('range input was not found');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(String(value))});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `, { userGesture: true });
}

async function getAudioCurrentTime(cdp: CdpClient) {
  return evaluate<number>(cdp, `(() => {
    const audio = document.querySelector('audio');
    return audio ? Number(audio.currentTime || 0) : 0;
  })()`);
}

async function getPrimaryRangeValue(cdp: CdpClient) {
  return evaluate<number>(cdp, `(() => {
    const input = document.querySelector('input[type="range"]');
    return input ? Number(input.value || 0) : NaN;
  })()`);
}

async function clickYoutubeChannelSuggestion(cdp: CdpClient, expectedTitle: string) {
  const clicked = await evaluate<boolean>(cdp, `
    (() => {
      const expected = ${JSON.stringify(expectedTitle)}.toLowerCase();
      const buttons = Array.from(document.querySelectorAll('button[aria-label^="Open YouTube channel"]'));
      const button = buttons.find((item) => {
        const label = String(item.getAttribute('aria-label') || '').toLowerCase();
        const text = String(item.textContent || '').toLowerCase();
        return label.includes(expected) || text.includes(expected);
      }) || buttons[0];
      if (!button) return false;
      button.click();
      return true;
    })()
  `, { userGesture: true });
  assert(clicked, "cached YouTube channel suggestion was not clickable");
}

async function clickYoutubeVideoResult(cdp: CdpClient, expectedTitle: string) {
  const clicked = await evaluate<boolean>(cdp, `
    (() => {
      const expected = ${JSON.stringify(expectedTitle)}.toLowerCase();
      const buttons = Array.from(document.querySelectorAll('button'));
      const button = buttons.find((item) => {
        const text = String(item.textContent || '').toLowerCase();
        return text.includes(expected) && text.includes('youtube');
      });
      if (!button) return false;
      button.click();
      return true;
    })()
  `, { userGesture: true });
  assert(clicked, `YouTube video result was not clickable: ${expectedTitle}`);
}

async function searchYoutubeInUi(cdp: CdpClient, value: string) {
  await evaluate(cdp, `
    (() => {
      const openButton = document.querySelector('button.fixed.right-3.top-3');
      if (openButton) openButton.click();
    })()
  `, { userGesture: true });

  await waitFor("search input", async () => {
    return evaluate<boolean>(cdp, `Boolean(document.querySelector(${JSON.stringify(SEARCH_INPUT_SELECTOR)}))`);
  }, 10_000);

  await evaluate(cdp, `
    (() => {
      const input = document.querySelector(${JSON.stringify(SEARCH_INPUT_SELECTOR)});
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `, { userGesture: true });
}

async function setSearchValue(cdp: CdpClient, value: string) {
  await waitFor("search input", async () => {
    return evaluate<boolean>(cdp, `Boolean(document.querySelector(${JSON.stringify(SEARCH_INPUT_SELECTOR)}))`);
  }, 10_000);

  await evaluate(cdp, `
    (() => {
      const input = document.querySelector(${JSON.stringify(SEARCH_INPUT_SELECTOR)});
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `, { userGesture: true });
}

async function typeSearchValueSlowly(cdp: CdpClient, value: string, intervalMs: number) {
  await searchYoutubeInUi(cdp, "");
  for (let index = 1; index <= value.length; index += 1) {
    await setSearchValue(cdp, value.slice(0, index));
    await delay(intervalMs);
  }
}

async function dropAudioFixture(cdp: CdpClient, filePath: string) {
  const base64 = fs.readFileSync(filePath).toString("base64");
  await evaluate(cdp, `
    (async () => {
      const binary = atob(${JSON.stringify(base64)});
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const file = new File([bytes], ${JSON.stringify(FIXTURE_NAME)}, { type: 'audio/wav', lastModified: Date.now() });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        window.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })()
  `, { userGesture: true });
}

async function readSavedTimingSummary(cdp: CdpClient) {
  return evaluate<any>(cdp, `
    new Promise((resolve, reject) => {
      const request = indexedDB.open('living-sketchbook-library', 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('songs', 'readonly');
        const store = tx.objectStore('songs');
        const getAll = store.getAll();
        getAll.onerror = () => reject(getAll.error);
        getAll.onsuccess = () => {
          const song = (getAll.result || []).find((item) => item.name === ${JSON.stringify(FIXTURE_NAME)});
          if (!song || !song.timing || !song.timing.textCache) {
            resolve(null);
            return;
          }
          let timing = null;
          try {
            timing = JSON.parse(song.timing.textCache);
          } catch (error) {
            reject(error);
            return;
          }
          const segments = Array.isArray(timing.segments) ? timing.segments : [];
          resolve({
            songName: song.name,
            generatedAt: timing.generatedAt || '',
            segmentCount: segments.length,
            translationSource: timing.translationSource || '',
            translationError: timing.translationError || '',
            translatedCount: segments.filter((segment) => String(segment.translation || '').trim()).length,
            primaryPreview: segments.map((segment) => segment.primary || segment.raw || '').filter(Boolean).join(' ').slice(0, 240),
            translationPreview: segments.map((segment) => segment.translation || '').filter(Boolean).join(' ').slice(0, 240),
          });
        };
      };
    })
  `);
}

async function readYoutubeTimingSummary(cdp: CdpClient, videoId: string) {
  return evaluate<any>(cdp, `
    new Promise((resolve, reject) => {
      const request = indexedDB.open('living-sketchbook-library', 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('songs', 'readonly');
        const store = tx.objectStore('songs');
        const getAll = store.getAll();
        getAll.onerror = () => reject(getAll.error);
        getAll.onsuccess = () => {
          const song = (getAll.result || []).find((item) => item.youtubeVideoId === ${JSON.stringify(videoId)});
          if (!song || !song.timing || !song.timing.textCache) {
            resolve(null);
            return;
          }
          let timing = null;
          try {
            timing = JSON.parse(song.timing.textCache);
          } catch (error) {
            reject(error);
            return;
          }
          const segments = Array.isArray(timing.segments) ? timing.segments : [];
          const first = segments[0] || {};
          resolve({
            songName: song.name,
            source: timing.source || '',
            transcriptionSource: timing.transcriptionSource || '',
            translationSource: timing.translationSource || '',
            translationError: timing.translationError || '',
            trackKind: timing.youtubeCaptionTrack?.trackKind || '',
            automaticCaptionsAllowed: timing.youtubeCaptionTrack?.automaticCaptionsAllowed === true,
            segmentCount: segments.length,
            firstText: first.primary || first.raw || '',
            firstWordCount: Array.isArray(first.words) ? first.words.length : 0,
            firstCharacterCount: Array.isArray(first.characterTimeline) ? first.characterTimeline.length : 0,
            fileSize: song.file ? song.file.size : 0,
          });
        };
      };
    })
  `);
}

async function main() {
  assert(fs.existsSync(CHROME_PATH), `Chrome was not found at ${CHROME_PATH}`);
  assert(process.env.ELEVENLABS_API_KEY, "ELEVENLABS_API_KEY is not set in the environment");
  assert(process.env.GEMINI_API_KEYS, "GEMINI_API_KEYS is not set in the environment");

  const health = await fetchJson(new URL("/api/health", APP_URL).toString());
  assert(health?.status === "ok", "backend health check did not return ok");

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "living-sketchbook-user-smoke-"));
  const userDataDir = path.join(workDir, "chrome-profile");
  const fixturePath = path.join(workDir, FIXTURE_NAME);
  await generateSpeechFixture(fixturePath);

  const chrome = spawn(CHROME_PATH, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

  let cdp: CdpClient | null = null;
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const httpErrors: string[] = [];
  const youtubeResolveRequests: string[] = [];
  const scribeWebSockets: string[] = [];

  try {
    const target = await waitForChromeTarget();
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    cdp.on("Runtime.exceptionThrown", (params) => {
      consoleErrors.push(params?.exceptionDetails?.exception?.description || params?.exceptionDetails?.text || "Unhandled browser exception");
    });
    cdp.on("Runtime.consoleAPICalled", (params) => {
      if (!["error", "assert"].includes(params?.type)) return;
      const text = (params.args || []).map((arg: any) => arg.value || arg.description || "").join(" ");
      if (/Failed to load resource/i.test(text)) return;
      consoleErrors.push(text);
    });
    cdp.on("Log.entryAdded", (params) => {
      if (["error", "warning"].includes(params?.entry?.level)) {
        const text = params.entry.text || "";
        if (/Failed to load resource/i.test(text)) return;
        consoleErrors.push(text);
      }
    });
    cdp.on("Network.loadingFailed", (params) => {
      if (!params?.canceled) failedRequests.push(`${params?.errorText || "request failed"} ${params?.requestId || ""}`);
    });
    cdp.on("Network.responseReceived", (params) => {
      const response = params?.response;
      const status = Number(response?.status) || 0;
      const url = String(response?.url || "");
      if (status >= 400 && !/favicon\.ico/i.test(url)) {
        httpErrors.push(`${status} ${url}`);
      }
    });
    cdp.on("Network.requestWillBeSent", (params) => {
      const request = params?.request;
      const url = String(request?.url || "");
      if (/\/api\/youtube\/resolve\b/.test(url)) {
        youtubeResolveRequests.push(String(request?.postData || ""));
      }
    });
    cdp.on("Network.webSocketCreated", (params) => {
      const url = String(params?.url || "");
      if (/\/api\/elevenlabs\/scribe-live\b/.test(url)) {
        scribeWebSockets.push(url);
      }
    });

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");

    const loadEvent = new Promise<void>((resolve) => cdp?.on("Page.loadEventFired", () => resolve()));
    await cdp.send("Page.navigate", { url: APP_URL });
    await Promise.race([loadEvent, delay(20_000)]);

    let lastReadyText = "";
    await waitFor("app ready", async () => {
      const state = await evaluate<{ ready: boolean; text: string }>(cdp!, `
        (() => {
          const text = document.body ? document.body.innerText : '';
          return {
            text,
            ready: Boolean(document.querySelector('#visualizer-canvas')) &&
              !/Waking backend|Backend unavailable/i.test(text),
          };
        })()
      `);
      lastReadyText = state.text;
      return state.ready ? state.text : null;
    }, 30_000).catch((error) => {
      throw new Error(`${error.message}\nLast page text:\n${lastReadyText}`);
    });

    const slowChannelResolveStart = youtubeResolveRequests.length;
    await typeSearchValueSlowly(cdp, SLOW_CHANNEL_QUERY, SLOW_CHANNEL_KEY_INTERVAL_MS);
    await delay(SLOW_CHANNEL_SETTLE_MS);
    const slowChannelResolveRequests = youtubeResolveRequests.slice(slowChannelResolveStart);
    assert(
      slowChannelResolveRequests.length === 0,
      `slow channel typing made ${slowChannelResolveRequests.length} backend resolve requests: ${slowChannelResolveRequests.join(" | ")}`,
    );
    await setSearchValue(cdp, "");

    const expectedChannelTitle = YOUTUBE_CHANNEL_EXPECTED_TITLE.toLowerCase();
    await searchYoutubeInUi(cdp, YOUTUBE_CHANNEL_SMOKE_INPUT);
    const channelText = await waitFor("YouTube channel resolved in UI", async () => {
      const text = await getBodyText(cdp!);
      if (/YouTube unavailable|YouTube lookup failed|blocked anonymous|rejected the backend cookies/i.test(text)) {
        throw new Error(text);
      }
      return text.toLowerCase().includes(expectedChannelTitle) && /videos|YouTube/i.test(text) ? text : null;
    }, 60_000, 1000);

    await setSearchValue(cdp, "");
    const cachedSuggestionStart = youtubeResolveRequests.length;
    await setSearchValue(cdp, SLOW_CHANNEL_QUERY);
    const cachedSuggestionText = await waitFor("cached channel suggestion", async () => {
      const text = await getBodyText(cdp!);
      return text.toLowerCase().includes(expectedChannelTitle) && /cached videos|YouTube channel/i.test(text) ? text : null;
    }, 5_000, 200);
    await delay(1200);
    const cachedSuggestionRequests = youtubeResolveRequests.slice(cachedSuggestionStart);
    assert(
      cachedSuggestionRequests.length === 0,
      `cached channel suggestion typing made ${cachedSuggestionRequests.length} backend resolve requests: ${cachedSuggestionRequests.join(" | ")}`,
    );
    await clickYoutubeChannelSuggestion(cdp, YOUTUBE_CHANNEL_EXPECTED_TITLE);
    await waitFor("cached channel suggestion opened", async () => {
      const text = await getBodyText(cdp!);
      return text.toLowerCase().includes(expectedChannelTitle) && /videos|YouTube/i.test(text) ? text : null;
    }, 10_000, 500);
    await setSearchValue(cdp, "");

    await dropAudioFixture(cdp, fixturePath);
    await waitFor("dropped audio imported", async () => {
      const text = await getBodyText(cdp!);
      return text.includes(FIXTURE_NAME) ? text : null;
    }, 20_000);

    await clickButtonByAriaLabel(cdp, "Play").catch(() => false);

    const timing = await waitFor("saved timing persisted", async () => {
      const text = await getBodyText(cdp!);
      if (/Scribe failed|Section failed/i.test(text)) throw new Error(text);
      if (/Scribe failed|Section failed|Synced without translation|authentication|quota|billing/i.test(text)) {
        throw new Error(text);
      }
      const summary = await readSavedTimingSummary(cdp!);
      return summary?.segmentCount ? summary : null;
    }, SYNC_TIMEOUT_MS, 1000);
    const finalText = await getBodyText(cdp);
    assert(timing.segmentCount > 0, "saved timing has no segments");
    assert(!timing.translationError, `translation error was saved: ${timing.translationError}`);
    assert(timing.translatedCount > 0, "saved timing has no translated segments");
    assert(/gemini|flash/i.test(timing.translationSource), `unexpected translation source: ${timing.translationSource}`);
    assert(/release smoke test|living sketchbook|backend/i.test(timing.primaryPreview), `unexpected transcript preview: ${timing.primaryPreview}`);

    await clickButtonByText(cdp, "Translations only");
    await setPrimaryRangeValue(cdp, 0);
    await clickButtonByAriaLabel(cdp, "Replace translations in range");
    await clickButtonByAriaLabel(cdp, "Preview translation range");
    await waitFor("translation range preview advanced", async () => {
      return await getAudioCurrentTime(cdp!) > 0.75 ? true : null;
    }, 20_000, 250);
    await waitFor("translation range slider advanced", async () => {
      return await getPrimaryRangeValue(cdp!) > 0.75 ? true : null;
    }, 5_000, 250);
    const rangeText = await getBodyText(cdp);
    assert(/Range/i.test(rangeText), "translation range preview did not show Range status");
    await clickButtonByAriaLabel(cdp, "Apply translation range");
    const replacedTiming = await waitFor("translation-only range saved", async () => {
      const text = await getBodyText(cdp!);
      if (/Translation failed|authentication|quota|billing/i.test(text)) throw new Error(text);
      const summary = await readSavedTimingSummary(cdp!);
      return summary?.generatedAt && summary.generatedAt !== timing.generatedAt ? summary : null;
    }, 90_000, 1000);
    assert(replacedTiming.translatedCount > 0, "translation-only replacement removed all translations");
    assert(/gemini|flash/i.test(replacedTiming.translationSource), `unexpected replacement translation source: ${replacedTiming.translationSource}`);

    await searchYoutubeInUi(cdp, YOUTUBE_SMOKE_URL);
    const youtubeText = await waitFor("YouTube video resolved in UI", async () => {
      const text = await getBodyText(cdp!);
      if (/YouTube unavailable|YouTube lookup failed|blocked anonymous|rejected the backend cookies/i.test(text)) {
        throw new Error(text);
      }
      return /Me at the zoo/i.test(text) ? text : null;
    }, 60_000, 1000);
    const youtubeTitle = youtubeText.split(/\n+/).find((line) => /Me at the zoo/i.test(line)) || "";
    const scribeWebSocketsBeforeYoutubeImport = scribeWebSockets.length;
    await clickYoutubeVideoResult(cdp, "Me at the zoo");
    const youtubeTiming = await waitFor("YouTube caption timing saved", async () => {
      const text = await getBodyText(cdp!);
      if (/YouTube import failed|YouTube download failed/i.test(text)) throw new Error(text);
      const summary = await readYoutubeTimingSummary(cdp!, "jNQXAC9IVRw");
      return summary?.segmentCount ? summary : null;
    }, 120_000, 1000);
    assert(youtubeTiming.fileSize > 0, "YouTube import did not persist an audio file");
    assert(/^youtube-captions/.test(youtubeTiming.transcriptionSource), `YouTube timing used ${youtubeTiming.transcriptionSource}`);
    assert(youtubeTiming.trackKind === "manual", `YouTube timing used ${youtubeTiming.trackKind || "unknown"} captions`);
    assert(!youtubeTiming.automaticCaptionsAllowed, "YouTube automatic captions were enabled by default");
    assert(youtubeTiming.segmentCount > 0, "YouTube caption timing has no segments");
    assert(youtubeTiming.firstWordCount > 0, "YouTube caption timing has no word timing");
    assert(youtubeTiming.firstCharacterCount > 0, "YouTube caption timing has no character timing");
    assert(/elephants|all right|here we are/i.test(youtubeTiming.firstText), `unexpected YouTube caption text: ${youtubeTiming.firstText}`);
    assert(
      scribeWebSockets.length === scribeWebSocketsBeforeYoutubeImport,
      "YouTube caption import opened a new ElevenLabs Scribe WebSocket",
    );

    const severeConsole = consoleErrors.filter((entry) => entry && !/favicon|DevTools|Failed to load resource/i.test(entry));
    assert(!severeConsole.length, `browser console errors: ${severeConsole.join(" | ")}`);
    assert(!failedRequests.length, `browser request failures: ${failedRequests.join(" | ")}`);
    assert(!httpErrors.length, `browser HTTP errors: ${httpErrors.join(" | ")}`);

    console.log("user browser smoke ok");
    console.log(JSON.stringify({
      statusText: finalText.split(/\n+/).filter(Boolean).slice(0, 8),
      youtubeText: youtubeText.split(/\n+/).filter(Boolean).slice(0, 8),
      youtubeTitle,
      youtubeTiming,
      channelText: channelText.split(/\n+/).filter(Boolean).slice(0, 8),
      cachedSuggestionText: cachedSuggestionText.split(/\n+/).filter(Boolean).slice(0, 8),
      slowChannelResolveCount: slowChannelResolveRequests.length,
      cachedSuggestionResolveCount: cachedSuggestionRequests.length,
      timing,
    }, null, 2));
  } finally {
    cdp?.close();
    if (chrome.exitCode == null && !chrome.killed) chrome.kill();
    await Promise.race([once(chrome, "close"), delay(5000)]).catch(() => {});
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
