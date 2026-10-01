/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { useStore, GlobalState } from "./store";
import { AUDIO_EXTENSIONS, TRANSCRIPT_EXTENSIONS } from "./fileSystem";
import { getExtension, getBaseName, getAudioMimeType, getFileRelativePath, getTopFolderName, createId, getSongFileKey } from "./utils";
import { parseTranscript } from "./parser";
import { importLocalSuno } from "./localSuno";

export async function handleGlobalDroppedFiles(files: File[], signal?: AbortSignal) {
    const audioFiles: File[] = [];
    const transcriptFiles: File[] = [];

    for (const file of files) {
        const ext = getExtension(file.name);
        if (file.type.startsWith("video/") || ["mp4", "mkv", "mov"].includes(ext)) {
            useStore.setState({ commitFeedback: `Extracting audio and bilingual lyrics from ${file.name}…` });
            const imported = await importLocalSuno(file, signal);
            audioFiles.push(imported.audio);
            transcriptFiles.push(imported.timing);
        } else if (AUDIO_EXTENSIONS.has(ext) || file.type.startsWith("audio/")) {
            audioFiles.push(file);
        } else if (TRANSCRIPT_EXTENSIONS.has(ext)) {
            transcriptFiles.push(file);
        }
    }

    const addedSongs = await addAudioFiles(audioFiles);
    await addTranscriptFiles(transcriptFiles, addedSongs);
    await pairOrphanTextItems();
    return { addedSongs, audioFiles, transcriptFiles };
}

async function ensureParsed(item: any) {
    if (item.segments) return item;
    const text = item.textCache || await item.file.text();
    item.textCache = text;
    const result = parseTranscript(text, getExtension(item.name));
    item.kind = result.kind;
    item.title = result.title || "";
    item.segments = result.segments;
    return item;
}

function getSongMetadata(options: any = {}) {
    return options?.metadata && typeof options.metadata === "object" ? { ...options.metadata } : {};
}

function createSongFromFile(file: File, options: any = {}) {
    const relativePath = file.webkitRelativePath || (file as any)._relativePath || file.name;
    let fallbackType = file.type;
    if (!fallbackType) {
        fallbackType = getAudioMimeType(file);
    }
    const playbackBlob = getExtension(file.name) === "vaw" ? file.slice(0, file.size, "audio/wav") : file;
    const metadata = getSongMetadata(options);

    return {
        ...metadata,
        id: options.id || createId("song"),
        key: getSongFileKey(file),
        file,
        name: file.name,
        base: getBaseName(file.name),
        size: file.size,
        type: fallbackType,
        lastModified: file.lastModified || Date.now(),
        relativePath,
        folderHandleId: "",
        folderLabel: getTopFolderName(relativePath),
        fileHandleId: "",
        fileLabel: file.name,
        timing: null,
        recoveryStatus: "",
        needsRecovery: false,
        url: URL.createObjectURL(playbackBlob)
    };
}

export async function addAudioFiles(files: File[], options: any = {}) {
    const state = useStore.getState();
    const added: any[] = [];
    const newAudioFiles = [...state.audioFiles];

    for (const file of files) {
        const fileOptions = typeof options === "function" ? (options(file) || {}) : options;
        const metadata = getSongMetadata(fileOptions);
        const key = getSongFileKey(file);
        const existingId = newAudioFiles.findIndex(item => item.key === key);
        if (existingId >= 0) {
            const existing = newAudioFiles[existingId];
            if (existing.url) URL.revokeObjectURL(existing.url);
            const playbackBlob = getExtension(file.name) === "vaw" ? file.slice(0, file.size, "audio/wav") : file;
            Object.assign(existing, metadata);
            existing.file = file;
            existing.url = URL.createObjectURL(playbackBlob);
            existing.needsRecovery = false;
            existing.recoveryStatus = "";
            added.push(existing);
        } else {
            const song = createSongFromFile(file, fileOptions);
            newAudioFiles.push(song);
            added.push(song);
        }
    }
    useStore.setState({ audioFiles: newAudioFiles });
    return added;
}

function createTranscriptItem(file: File, options: any = {}) {
    return {
        id: createId("transcript"),
        key: `${file.name}:${file.size}:${file.lastModified}`,
        file,
        name: file.name,
        base: getBaseName(file.name),
        status: "ready",
        segments: null,
        error: "",
        source: options.source || "imported",
        persistedId: "",
        textCache: "",
        updatedAt: file.lastModified || Date.now(),
        kind: "" as string,
        title: "" as string
    };
}

async function addTranscriptFiles(files: File[], preferSongs: any[] = []) {
    const state = useStore.getState();
    const newOrphans = [...state.orphanTextItems];

    for (const f of files) {
        const key = `${f.name}:${f.size}:${f.lastModified}`;
        if (newOrphans.find(i => i.key === key)) continue;
        
        const item = createTranscriptItem(f);
        await ensureParsed(item);
        
        // Find best song
        const target = findSongForTextItem(item, preferSongs);
        if (target) {
            await applyTextItemToSong(target, item);
        } else {
            newOrphans.push(item);
            useStore.setState({
                commitFeedback: `Loaded timing '${item.name}'. Drop matching audio/video to play.`
            });
        }
    }

    useStore.setState({ orphanTextItems: newOrphans });
}

function normalizeForMatch(str: string): string {
    return (str || "")
        .toLowerCase()
        .replace(/(_visual_timings|_whisper_words|_timings|_timing|_lyrics|_transcript|_subtitles|_synced|_words|_cues)/gi, "")
        .replace(/[^a-z0-9]+/g, "");
}

function findSongForTextItem(item: any, preferSongs: any[]) {
    const state = useStore.getState();
    const candidateSongs = [...preferSongs, ...state.audioFiles];
    if (!candidateSongs.length) return null;

    const itemRaw = (item.base || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const itemNorm = normalizeForMatch(item.base);

    const matches = (song: any) => {
        if (!song) return false;
        const songRaw = (song.base || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
        const songNorm = normalizeForMatch(song.base);
        return (
            itemNorm === songNorm ||
            itemRaw === songRaw ||
            (Boolean(itemNorm) && Boolean(songNorm) && (itemNorm.includes(songNorm) || songNorm.includes(itemNorm))) ||
            (Boolean(itemRaw) && Boolean(songRaw) && (itemRaw.includes(songRaw) || songRaw.includes(itemRaw)))
        );
    };

    // 1. First check newly added songs
    const preferred = preferSongs.find(matches);
    if (preferred) return preferred;

    // 2. If currently active song in player matches
    if (state.selectedAudioId) {
        const activeSong = state.audioFiles.find(s => s.id === state.selectedAudioId);
        if (activeSong && matches(activeSong)) return activeSong;
    }

    // 3. Check any audio file in library
    const found = state.audioFiles.find(matches);
    if (found) return found;

    // 4. Fallback: if only 1 song in library, pair with it
    if (state.audioFiles.length === 1) {
        return state.audioFiles[0];
    }

    // 5. Fallback: if currently selected song exists, pair with it
    if (state.selectedAudioId) {
        const activeSong = state.audioFiles.find(s => s.id === state.selectedAudioId);
        if (activeSong) return activeSong;
    }

    return null;
}

export async function applyTextItemToSong(song: any, item: any) {
    await ensureParsed(item);
    item.kind = "timed";
    
    const state = useStore.getState();
    const newAudioFiles = state.audioFiles.map(s => {
        if (s.id === song.id) {
            return {
                ...s,
                timing: item,
                recoveryStatus: ""
            };
        }
        return s;
    });

    useStore.setState({ audioFiles: newAudioFiles });

    // If this song is currently selected or no song is selected yet, load its segments immediately into the active player
    if (!state.selectedAudioId || state.selectedAudioId === song.id) {
        await loadSongSegments(song.id);
    }
}

export async function pairOrphanTextItems() {
    const state = useStore.getState();
    if (!state.orphanTextItems.length || !state.audioFiles.length) return;

    const remaining = [];
    for (const item of state.orphanTextItems) {
        const song = findSongForTextItem(item, []);
        if (song) {
            await applyTextItemToSong(song, item);
        } else {
            remaining.push(item);
        }
    }
    useStore.setState({ orphanTextItems: remaining });
}

export async function loadSongSegments(songId: string) {
    const state = useStore.getState();
    const song = state.audioFiles.find(s => s.id === songId);
    if (!song) return;

    let timingSegments: any[] = [];
    
    if (song.timing) {
        await ensureParsed(song.timing);
        timingSegments = song.timing.segments || [];
    }

    let finalSegments = timingSegments;

    // Distribute untimed segments
    let cursor = 0;
    const distributed = finalSegments.map(s => {
        const start = Number.isFinite(s.start) ? s.start : cursor;
        const end = Number.isFinite(s.end) && s.end > start ? s.end : start + Math.max(1, (s.raw?.length || 0) / 24 * 3);
        cursor = end;
        return { ...s, start, end };
    });

    useStore.setState({ 
        segments: distributed, 
        currentSegmentIndex: -1, 
        selectedAudioId: songId,
        scribeMessage: song.timing ? "Synced" : "Ready",
        commitFeedback: song.timing ? `Loaded ${distributed.length} lyric lines` : ""
    });
}
