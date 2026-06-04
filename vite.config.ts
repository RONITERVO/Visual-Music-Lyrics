/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

function resolvePagesBasePath() {
  const rawBasePath = process.env.VITE_BASE_PATH || process.env.GITHUB_REPOSITORY?.split('/').pop() || 'Audio-visualizer-ai-studio-edition';
  const cleanedBasePath = String(rawBasePath || '').trim().replace(/^\/+|\/+$/g, '');
  return cleanedBasePath ? `/${cleanedBasePath}/` : '/';
}

export default defineConfig(({mode}) => {
  return {
    base: mode === 'pages' ? resolvePagesBasePath() : '/',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
