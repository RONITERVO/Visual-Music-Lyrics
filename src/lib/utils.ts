/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

export function getExtension(name: string) { const match = /\.([^.]+)$/.exec(name || ""); return match ? match[1].toLowerCase() : ""; }
export function getBaseName(name: string) { return (name || "").replace(/\.[^.]+$/, ""); }
export function cleanTitle(name: string) { return getBaseName(name || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled"; }
export function normalizeName(name: string) { return cleanTitle(name).toLowerCase().replace(/[^a-z0-9]+/g, ""); }
export function createId(prefix: string) { return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`; }
export function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
export function easeOutCubic(value: number) { return 1 - Math.pow(1 - value, 3); }

export function formatBytes(bytes: number) { 
  if (!Number.isFinite(bytes)) return ""; 
  if (bytes < 1024) return `${bytes} B`; 
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; 
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; 
}

export function formatClock(seconds: number) { 
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00"; 
  const mins = Math.floor(seconds / 60); 
  const secs = Math.floor(seconds % 60); 
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`; 
}

export function formatPreciseClock(seconds: number) { 
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00.00"; 
  const mins = Math.floor(seconds / 60); 
  const secs = seconds - mins * 60; 
  return `${String(mins).padStart(2, "0")}:${secs.toFixed(2).padStart(5, "0")}`; 
}

export function pseudoRandom(seed: number) { 
  const value = Math.sin(seed * 12.9898) * 43758.5453; 
  return value - Math.floor(value); 
}

export function getEnergy(array: Uint8Array, start: number, end: number) { 
  const safeStart = Math.max(0, Math.floor(start)); 
  const safeEnd = Math.min(array.length, Math.max(safeStart + 1, Math.floor(end))); 
  let sum = 0; 
  for (let index = safeStart; index < safeEnd; index += 1) sum += array[index]; 
  return sum / ((safeEnd - safeStart) * 255); 
}

export function idleEnergy(t: number) { 
  return 0.18 + 0.08 * Math.sin(t * 1.4) + 0.04 * Math.sin(t * 2.7); 
}

export function getAudioMimeType(file: File) {
  if (file.type && file.type.startsWith("audio/")) return file.type;
  const ext = getExtension(file.name);
  if (ext === "mp3") return "audio/mpeg"; if (ext === "m4a") return "audio/mp4";
  if (ext === "vaw" || ext === "wav") return "audio/wav";
  if (ext === "ogg") return "audio/ogg"; if (ext === "webm") return "audio/webm";
  if (ext === "flac") return "audio/flac"; return "audio/mpeg";
}

export function getFileRelativePath(file: File, fallback = ""): string {
  return (file as any)._relativePath || file.webkitRelativePath || fallback || file.name;
}

export function getTopFolderName(relativePath: string): string {
  const parts = String(relativePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 1 ? parts[0] : "";
}

export function getSongFileKey(file: File, options: any = {}): string {
  if (options.fileHandleId) return `handle:${options.fileHandleId}`;
  const relativePath = getFileRelativePath(file, options.relativePath);
  const pathPart = relativePath && relativePath !== file.name ? `${relativePath}:` : "";
  return `${pathPart}${file.name}:${file.size}:${file.lastModified}`;
}

export function sanitizeFileBase(name: string) { return cleanTitle(name).replace(/[^a-zA-Z0-9 _-]+/g, "").replace(/\s+/g, "-") || "text"; }
export function getTextMimeType(name: string) { return getExtension(name) === "json" ? "application/json" : "text/plain"; }
export function looksLikeJson(text: string) { return (text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]")); }
export function looksLikeLooseJson(text: string) { return /^"[^"]+"\s*:/.test(text.trim()); }
export function revealText(text: string, progress: number) { 
  if (!text) return ""; 
  if (progress >= 0.995) return text; 
  const visible = Math.max(1, Math.floor(text.length * progress)); 
  return text.slice(0, visible); 
}
