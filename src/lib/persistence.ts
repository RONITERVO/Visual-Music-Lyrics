/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { useStore } from "./store";
import type { GlobalState } from "./store";
import { clearAllSongsFromDb, getAllSongsFromDb, storeSongInDb } from "./db";

const SETTINGS_KEYS = {
    elevenLabsApiKey: "living-sketchbook:elevenlabs-api-key",
    sourceLanguage: "living-sketchbook:source-language",
    targetLanguage: "living-sketchbook:target-language",
    translationEnabled: "living-sketchbook:translation-enabled",
    youtubeApiKey: "living-sketchbook:youtube-api-key",
    allowAutomaticYoutubeCaptions: "living-sketchbook:allow-automatic-youtube-captions",
};

type PersistedSettings = Pick<GlobalState,
    "elevenLabsApiKey" |
    "sourceLanguage" |
    "targetLanguage" |
    "translationEnabled" |
    "youtubeApiKey" |
    "allowAutomaticYoutubeCaptions"
>;

let shouldSkipNextLibraryPersist = false;
let shouldSkipNextSettingsSave = false;

export function suppressNextLibraryPersist() {
    shouldSkipNextLibraryPersist = true;
}

export function suppressNextSettingsSave() {
    shouldSkipNextSettingsSave = true;
}

export async function persistLibrary() {
    if (shouldSkipNextLibraryPersist) {
        shouldSkipNextLibraryPersist = false;
        return;
    }

    const { audioFiles } = useStore.getState();
    for (const song of audioFiles) {
        if (!song || !song.name) continue;
        try {
            await storeSongInDb(song);
        } catch(e) {
            console.error("IDB save failed", e);
        }
    }
}

export async function restorePersistedLibrary() {
    try {
        const records: any[] = await getAllSongsFromDb();
        const state = useStore.getState();
        const audioFiles = [...state.audioFiles];
        
        for (const record of records) {
            // Re-create object URLs for the audio blobs so they can play
            if (record.file && !record.url) {
                try {
                    record.url = URL.createObjectURL(record.file);
                } catch(e) {}
            }
            if(!audioFiles.some(s => s.id === record.id)) {
                 audioFiles.push(record);
            }
        }
        useStore.setState({ audioFiles });
    } catch(e) {
        console.error("Failed to restore from IDB", e);
    }
}

export function saveSettings(settings = useStore.getState()) {
    if (shouldSkipNextSettingsSave) {
        shouldSkipNextSettingsSave = false;
        return;
    }

    try {
        localStorage.setItem(SETTINGS_KEYS.elevenLabsApiKey, settings.elevenLabsApiKey || "");
        localStorage.setItem(SETTINGS_KEYS.youtubeApiKey, settings.youtubeApiKey || "");
        localStorage.setItem(SETTINGS_KEYS.allowAutomaticYoutubeCaptions, settings.allowAutomaticYoutubeCaptions ? "true" : "false");
        localStorage.setItem(SETTINGS_KEYS.sourceLanguage, settings.sourceLanguage || "");
        localStorage.setItem(SETTINGS_KEYS.targetLanguage, settings.targetLanguage || "en");
        localStorage.setItem(SETTINGS_KEYS.translationEnabled, settings.translationEnabled ? "true" : "false");
    } catch(e) {}
}

export function clearSavedSettings() {
    try {
        for (const key of Object.values(SETTINGS_KEYS)) {
            localStorage.removeItem(key);
        }
    } catch(e) {}
}

export async function clearPersistedUserData() {
    await clearAllSongsFromDb();
    clearSavedSettings();
    suppressNextLibraryPersist();
    suppressNextSettingsSave();
}

export function loadSettings(): PersistedSettings {
    try {
        return {
            elevenLabsApiKey: localStorage.getItem(SETTINGS_KEYS.elevenLabsApiKey) || "",
            sourceLanguage: localStorage.getItem(SETTINGS_KEYS.sourceLanguage) || "",
            targetLanguage: localStorage.getItem(SETTINGS_KEYS.targetLanguage) || "en",
            translationEnabled: localStorage.getItem(SETTINGS_KEYS.translationEnabled) !== "false",
            youtubeApiKey: localStorage.getItem(SETTINGS_KEYS.youtubeApiKey) || "",
            allowAutomaticYoutubeCaptions: localStorage.getItem(SETTINGS_KEYS.allowAutomaticYoutubeCaptions) === "true",
        };
    } catch(e) {
        return {
            elevenLabsApiKey: "",
            sourceLanguage: "",
            targetLanguage: "en",
            translationEnabled: true,
            youtubeApiKey: "",
            allowAutomaticYoutubeCaptions: false,
        };
    }
}
