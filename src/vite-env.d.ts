/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_DISABLE_FIREBASE_AUTH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
