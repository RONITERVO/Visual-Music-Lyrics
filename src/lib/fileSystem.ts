/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

export const AUDIO_EXTENSIONS = new Set(["wav", "vaw", "mp3", "m4a", "aac", "flac", "ogg", "webm"]);
export const TRANSCRIPT_EXTENSIONS = new Set(["json", "vtt", "srt", "txt", "text", "lyrics"]);

export async function getDroppedFiles(dataTransfer: DataTransfer): Promise<File[]> {
    const items = Array.from(dataTransfer.items || []);
    if (!items.length) return Array.from(dataTransfer.files || []);
    
    // Check if webkitGetAsEntry exists
    const entries = items.map(item => item.webkitGetAsEntry ? item.webkitGetAsEntry() : null).filter(Boolean);
    if (!entries.length) return Array.from(dataTransfer.files || []);
    
    const files: File[] = [];
    for (const entry of entries) {
        if (entry) {
            const nested = await readEntry(entry, "");
            files.push(...nested);
        }
    }
    return files;
}

function readEntry(entry: any, parentPath: string): Promise<File[]> {
    return new Promise((resolve) => {
        if (entry.isFile) {
            entry.file((file: File) => {
                const relativePath = parentPath ? `${parentPath}/${file.name}` : file.name;
                Object.defineProperty(file, "_relativePath", { value: relativePath, configurable: true });
                resolve([file]);
            }, () => resolve([]));
            return;
        }
        if (!entry.isDirectory) { resolve([]); return; }
        
        const reader = entry.createReader();
        const all: File[] = [];
        const readBatch = () => {
            reader.readEntries(async (entries: any[]) => {
                if (!entries.length) { resolve(all); return; }
                for (const child of entries) {
                    const nextPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
                    const nested = await readEntry(child, nextPath);
                    all.push(...nested);
                }
                readBatch();
            }, () => resolve(all));
        };
        readBatch();
    });
}
