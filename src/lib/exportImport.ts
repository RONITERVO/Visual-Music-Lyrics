/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { storeSongInDb } from "./db";
import { suppressNextLibraryPersist } from "./persistence";
import { useStore } from "./store";
import { createId, getBaseName, getExtension } from "./utils";

const EXPORT_KIND = "living-sketchbook-library";
const EXPORT_VERSION = 2;
const FILE_CHUNK_BYTES = 1024 * 1024;

type TransferPhase = "exporting" | "importing";

export interface LibraryTransferProgress {
  phase: TransferPhase;
  songsDone: number;
  songsTotal: number;
  bytesDone: number;
  bytesTotal: number;
  currentSong?: string;
}

export interface LibraryTransferOptions {
  onProgress?: (progress: LibraryTransferProgress) => void;
}

export interface LibraryExportResult {
  songs: number;
  bytes: number;
  streamed: boolean;
}

export interface LibraryImportResult {
  imported: number;
  updated: number;
  failed: number;
  bytes: number;
  firstPlayableId: string;
}

interface LibraryWriter {
  streamed: boolean;
  writeText: (value: string) => Promise<void>;
  close: () => Promise<void>;
}

interface PendingSongImport {
  song: any;
  fileMeta: any;
  chunks: Uint8Array[];
  bytesReceived: number;
}

function serializeTiming(timing: any) {
  if (!timing || typeof timing !== "object") return null;
  const { file: _file, url: _url, ...rest } = timing;
  return { ...rest, file: null };
}

function serializeSong(song: any) {
  const { file: _file, url: _url, ...rest } = song || {};
  return {
    ...rest,
    id: song?.id || createId("song"),
    name: song?.name || "Untitled audio",
    base: song?.base || getBaseName(song?.name || "Untitled audio"),
    timing: serializeTiming(song?.timing),
  };
}

function getSongFile(song: any): File | Blob | null {
  return song?.file instanceof Blob ? song.file : null;
}

function createFileMeta(song: any, file: File | Blob) {
  const fileName = file instanceof File ? file.name : song?.name || "audio";
  return {
    name: fileName,
    type: file.type || song?.type || "",
    size: file.size,
    lastModified: file instanceof File ? file.lastModified : song?.lastModified || Date.now(),
    chunkSize: FILE_CHUNK_BYTES,
    chunkCount: Math.ceil(file.size / FILE_CHUNK_BYTES),
  };
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const stringChunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += stringChunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + stringChunkSize));
  }

  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function createPlaybackUrl(file: File, name: string) {
  const playbackBlob = getExtension(name) === "vaw" ? file.slice(0, file.size, "audio/wav") : file;
  return URL.createObjectURL(playbackBlob);
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();

  window.setTimeout(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, 10000);
}

async function createLibraryWriter(fileName: string): Promise<LibraryWriter> {
  const picker = (window as any).showSaveFilePicker;

  if (typeof picker === "function") {
    try {
      const handle = await picker({
        suggestedName: fileName,
        types: [
          {
            description: "Sketchbook library",
            accept: { "application/x-ndjson": [".ndjson"] },
          },
        ],
      });
      const writable = await handle.createWritable();
      const encoder = new TextEncoder();

      return {
        streamed: true,
        writeText: (value) => writable.write(encoder.encode(value)),
        close: () => writable.close(),
      };
    } catch (error: any) {
      if (error?.name === "AbortError") throw error;
      console.warn("Falling back to in-memory library export.", error);
    }
  }

  const parts: BlobPart[] = [];

  return {
    streamed: false,
    writeText: async (value) => {
      parts.push(value);
    },
    close: async () => {
      downloadBlob(new Blob(parts, { type: "application/x-ndjson" }), fileName);
    },
  };
}

async function writeRecord(writer: LibraryWriter, record: any) {
  await writer.writeText(`${JSON.stringify(record)}\n`);
}

function getExportSettings() {
  const state = useStore.getState();
  return {
    sourceLanguage: state.sourceLanguage || "",
    targetLanguage: state.targetLanguage || "en",
    translationEnabled: state.translationEnabled !== false,
  };
}

function getImportSettings(record: any) {
  const settings = record?.settings;
  if (!settings || typeof settings !== "object") return null;

  return {
    sourceLanguage: String(settings.sourceLanguage || ""),
    targetLanguage: String(settings.targetLanguage || "en"),
    translationEnabled: settings.translationEnabled !== false,
  };
}

function notifyProgress(
  options: LibraryTransferOptions,
  progress: LibraryTransferProgress,
) {
  options.onProgress?.(progress);
}

export async function exportLibrary(options: LibraryTransferOptions = {}): Promise<LibraryExportResult> {
  const records = useStore.getState().audioFiles.filter((song) => song && song.name);
  const bytesTotal = records.reduce((total, song) => total + (getSongFile(song)?.size || 0), 0);
  const fileName = `sketchbook-library-${new Date().toISOString().slice(0, 10)}.ndjson`;
  const writer = await createLibraryWriter(fileName);

  let bytesDone = 0;
  let songsDone = 0;

  await writeRecord(writer, {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    songCount: records.length,
    byteCount: bytesTotal,
    chunkSize: FILE_CHUNK_BYTES,
    settings: getExportSettings(),
  });

  for (const song of records) {
    const serializedSong = serializeSong(song);
    const file = getSongFile(song);
    const fileMeta = file ? createFileMeta(song, file) : null;

    await writeRecord(writer, {
      kind: "song",
      song: serializedSong,
      file: fileMeta,
    });

    if (file) {
      for (let offset = 0, chunkIndex = 0; offset < file.size; offset += FILE_CHUNK_BYTES, chunkIndex += 1) {
        const end = Math.min(file.size, offset + FILE_CHUNK_BYTES);
        const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());

        await writeRecord(writer, {
          kind: "file-chunk",
          songId: serializedSong.id,
          index: chunkIndex,
          data: bytesToBase64(bytes),
        });

        bytesDone += bytes.byteLength;
        notifyProgress(options, {
          phase: "exporting",
          songsDone,
          songsTotal: records.length,
          bytesDone,
          bytesTotal,
          currentSong: serializedSong.name,
        });
      }
    }

    await writeRecord(writer, {
      kind: "song-end",
      songId: serializedSong.id,
    });

    songsDone += 1;
    notifyProgress(options, {
      phase: "exporting",
      songsDone,
      songsTotal: records.length,
      bytesDone,
      bytesTotal,
      currentSong: serializedSong.name,
    });
  }

  await writer.close();
  return { songs: records.length, bytes: bytesDone, streamed: writer.streamed };
}

function normalizeImportedTiming(timing: any) {
  if (!timing || typeof timing !== "object") return null;
  const { file: _file, url: _url, ...rest } = timing;
  return { ...rest, file: null };
}

function createImportedSong(data: any, importedFile: File | null) {
  const { kind: _kind, ...songData } = data || {};
  const name = String(songData?.name || importedFile?.name || "Recovered audio");
  const size = Number(songData?.size ?? importedFile?.size ?? 0);
  const lastModified = Number(songData?.lastModified || importedFile?.lastModified || Date.now());
  const type = String(songData?.type || importedFile?.type || "");
  const relativePath = String(songData?.relativePath || name);

  return {
    ...songData,
    id: songData?.id || createId("song"),
    key: songData?.key || `${relativePath}:${name}:${size}:${lastModified}`,
    file: importedFile,
    name,
    base: songData?.base || getBaseName(name),
    size,
    type,
    lastModified,
    relativePath,
    folderHandleId: songData?.folderHandleId || "",
    folderLabel: songData?.folderLabel || "",
    fileHandleId: songData?.fileHandleId || "",
    fileLabel: songData?.fileLabel || name,
    timing: normalizeImportedTiming(songData?.timing),
    recoveryStatus: importedFile ? "" : songData?.recoveryStatus || "Needs recovery",
    needsRecovery: importedFile ? false : true,
    url: importedFile ? createPlaybackUrl(importedFile, name) : "",
  };
}

async function readNdjsonLines(file: File, onLine: (line: string) => Promise<void>) {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) break;

      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      await onLine(line);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    await onLine(buffer);
  }
}

export async function importLibrary(file: File, options: LibraryTransferOptions = {}): Promise<LibraryImportResult> {
  const currentAudioFiles = [...useStore.getState().audioFiles];
  const pendingSongs = new Map<string, PendingSongImport>();
  const urlsToRevoke: string[] = [];
  const stats: LibraryImportResult = {
    imported: 0,
    updated: 0,
    failed: 0,
    bytes: 0,
    firstPlayableId: "",
  };

  let songsTotal = 0;
  let bytesTotal = file.size;
  let importedSettings: ReturnType<typeof getImportSettings> = null;
  let hasLibraryHeader = false;

  const notifyImportProgress = (currentSong?: string) => {
    notifyProgress(options, {
      phase: "importing",
      songsDone: stats.imported + stats.updated,
      songsTotal,
      bytesDone: stats.bytes,
      bytesTotal,
      currentSong,
    });
  };

  const upsertSong = async (songData: any, importedFile: File | null) => {
    const importedSong = createImportedSong(songData, importedFile);

    try {
      await storeSongInDb(importedSong);
    } catch (error) {
      stats.failed += 1;
      console.error("IDB import failed", error);
      return;
    }

    const existingIndex = currentAudioFiles.findIndex((song) => {
      return song.id === importedSong.id || (importedSong.key && song.key === importedSong.key);
    });

    if (existingIndex >= 0) {
      const existingUrl = currentAudioFiles[existingIndex]?.url;
      if (existingUrl && existingUrl !== importedSong.url) {
        urlsToRevoke.push(existingUrl);
      }
      currentAudioFiles[existingIndex] = importedSong;
      stats.updated += 1;
    } else {
      currentAudioFiles.push(importedSong);
      stats.imported += 1;
    }

    if (!stats.firstPlayableId && importedFile) {
      stats.firstPlayableId = importedSong.id;
    }
  };

  const finishPendingSong = async (songId: string) => {
    const pending = pendingSongs.get(songId);
    if (!pending) return;

    try {
      let importedFile: File | null = null;

      if (pending.fileMeta) {
        const expectedChunks = Number(pending.fileMeta.chunkCount || 0);
        const orderedChunks: Uint8Array[] = [];

        for (let index = 0; index < expectedChunks; index += 1) {
          const chunk = pending.chunks[index];
          if (!chunk) {
            throw new Error(`Missing chunk ${index} for ${pending.song?.name || songId}`);
          }
          orderedChunks.push(chunk);
        }

        importedFile = new File(orderedChunks, pending.fileMeta.name || pending.song?.name || "audio", {
          type: pending.fileMeta.type || pending.song?.type || "",
          lastModified: Number(pending.fileMeta.lastModified || pending.song?.lastModified || Date.now()),
        });

        const expectedSize = Number(pending.fileMeta.size || 0);
        if (expectedSize !== importedFile.size) {
          throw new Error(`Size mismatch for ${pending.song?.name || songId}`);
        }
      }

      await upsertSong(pending.song, importedFile);
      notifyImportProgress(pending.song?.name);
    } catch (error) {
      stats.failed += 1;
      console.error("Failed to import song", error);
    } finally {
      pendingSongs.delete(songId);
    }
  };

  const processLine = async (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;

    let data: any;
    try {
      data = JSON.parse(line);
    } catch (error) {
      stats.failed += 1;
      console.error("Failed to parse library line", error);
      return;
    }

    if (data.kind === EXPORT_KIND) {
      if (Number(data.version) !== EXPORT_VERSION) {
        throw new Error(`Unsupported library export version: ${data.version}`);
      }
      hasLibraryHeader = true;
      songsTotal = Number(data.songCount || 0);
      bytesTotal = Number(data.byteCount || file.size);
      importedSettings = getImportSettings(data);
      notifyImportProgress();
      return;
    }

    if (!hasLibraryHeader) {
      throw new Error("This is not a current Sketchbook library export.");
    }

    if (data.kind === "song") {
      const song = data.song || {};
      const songId = song.id || createId("song");
      pendingSongs.set(songId, {
        song: { ...song, id: songId },
        fileMeta: data.file || null,
        chunks: [],
        bytesReceived: 0,
      });
      if (!songsTotal) songsTotal = pendingSongs.size;
      return;
    }

    if (data.kind === "file-chunk") {
      const songId = String(data.songId || "");
      const pending = pendingSongs.get(songId);
      if (!pending) {
        stats.failed += 1;
        return;
      }

      const chunk = base64ToBytes(String(data.data || ""));
      const index = Number(data.index || 0);
      pending.chunks[index] = chunk;
      pending.bytesReceived += chunk.byteLength;
      stats.bytes += chunk.byteLength;
      notifyImportProgress(pending.song?.name);
      return;
    }

    if (data.kind === "song-end") {
      await finishPendingSong(String(data.songId || ""));
      return;
    }

    stats.failed += 1;
    console.error("Unknown library record", data.kind);
  };

  await readNdjsonLines(file, processLine);

  for (const songId of [...pendingSongs.keys()]) {
    await finishPendingSong(songId);
  }

  const statePatch: any = { audioFiles: currentAudioFiles };
  if (importedSettings) {
    Object.assign(statePatch, importedSettings);
  }

  suppressNextLibraryPersist();
  useStore.setState(statePatch);

  for (const url of urlsToRevoke) {
    URL.revokeObjectURL(url);
  }

  return stats;
}
