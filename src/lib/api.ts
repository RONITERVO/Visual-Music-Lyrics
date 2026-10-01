/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { getFirebaseIdToken } from './firebase';

const configuredApiBaseUrl = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const CLIENT_ID_STORAGE_KEY = 'living-sketchbook:client-id';

export interface BackendHealth {
  status: string;
  service?: string;
  now?: string;
}

function normalizeApiBaseUrl(value?: string) {
  const trimmedValue = String(value || '').trim();
  return trimmedValue ? trimmedValue.replace(/\/+$/, '') : '';
}

function normalizeApiPath(path: string) {
  return path.startsWith('/') ? path : `/${path}`;
}

function resolveApiBaseUrl() {
  if (configuredApiBaseUrl) return configuredApiBaseUrl;
  return '';
}

export function shouldUseHostedBackend() {
  if (import.meta.env.VITE_DISABLE_FIREBASE_AUTH === "true") {
    return false;
  }
  if (typeof window !== "undefined" && window.localStorage.getItem("local_auth_bypass") === "true") {
    return false;
  }
  return true;
}

export function buildApiUrl(path: string) {
  const normalizedPath = normalizeApiPath(path);
  const apiBaseUrl = resolveApiBaseUrl();
  if (!apiBaseUrl) return normalizedPath;

  return new URL(normalizedPath.slice(1), `${apiBaseUrl}/`).toString();
}

function createClientId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function getClientId() {
  if (typeof window === 'undefined') return '';

  try {
    const existing = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (existing) return existing;

    const next = createClientId();
    localStorage.setItem(CLIENT_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return '';
  }
}

export function getApiRequestHeaders(headers: Record<string, string> = {}) {
  const clientId = getClientId();
  return clientId ? { ...headers, 'X-Client-Id': clientId } : headers;
}

export async function getAuthorizedApiRequestHeaders(headers: Record<string, string> = {}) {
  const baseHeaders = getApiRequestHeaders(headers);
  const idToken = await getFirebaseIdToken().catch(() => "");
  return idToken ? { ...baseHeaders, Authorization: `Bearer ${idToken}` } : baseHeaders;
}

export async function fetchBackendHealth(signal?: AbortSignal): Promise<BackendHealth> {
  const response = await fetch(buildApiUrl('/api/health'), {
    method: 'GET',
    cache: 'no-store',
    signal,
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || `Backend health check failed (${response.status})`);
  }

  return {
    status: String(data?.status || 'ok'),
    service: data?.service ? String(data.service) : undefined,
    now: data?.now ? String(data.now) : undefined,
  };
}
