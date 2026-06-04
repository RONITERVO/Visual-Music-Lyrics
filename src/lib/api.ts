/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

const configuredApiBaseUrl = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const isPagesBuild = import.meta.env.MODE === 'pages';
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
  if (isPagesBuild) {
    throw new Error(getPagesBackendMessage());
  }
  return '';
}

export function getPagesBackendMessage() {
  return 'This GitHub Pages build serves the frontend only. Set VITE_API_BASE_URL to a deployed backend for transcription and translation, or run npm run dev locally.';
}

export function shouldUseHostedBackend() {
  return Boolean(configuredApiBaseUrl) || !isPagesBuild;
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

export function buildWebSocketUrl(path: string) {
  const normalizedPath = normalizeApiPath(path);
  const apiBaseUrl = resolveApiBaseUrl();

  if (!apiBaseUrl) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${normalizedPath}`;
  }

  const url = new URL(normalizedPath.slice(1), `${apiBaseUrl}/`);
  if (url.protocol === 'https:' || url.protocol === 'wss:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:' || url.protocol === 'ws:') {
    url.protocol = 'ws:';
  }

  return url.toString();
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
