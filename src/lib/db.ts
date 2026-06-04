/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { useStore } from './store';
import { getExtension, getBaseName } from './utils';

const DB_NAME = "living-sketchbook-library";
const DB_VERSION = 2;
const STORE_SONGS = "songs";

let dbPromise: Promise<IDBDatabase> | null = null;

export function getDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SONGS)) {
        db.createObjectStore(STORE_SONGS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function storeSongInDb(song: any) {
  const db = await getDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SONGS, "readwrite");
    const store = tx.objectStore(STORE_SONGS);
    // Don't store the .url as it's a blob URL that expires
    const songToStore = { ...song };
    delete songToStore.url;
    const req = store.put(songToStore);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getAllSongsFromDb(): Promise<any[]> {
    const db = await getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SONGS, "readonly");
      const store = tx.objectStore(STORE_SONGS);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
}

export async function clearAllSongsFromDb() {
  const db = await getDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SONGS, "readwrite");
    const store = tx.objectStore(STORE_SONGS);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
