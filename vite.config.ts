import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const contentPolicy = [
  "default-src 'none'",
  "script-src 'self' forma://app 'wasm-unsafe-eval'",
  "style-src 'self' forma://app 'unsafe-inline'",
  "font-src 'self' forma://app data: blob:",
  "img-src 'self' forma://app data: blob:",
  "connect-src 'self' forma://app blob: http://127.0.0.1:11434",
  "worker-src 'self' forma://app blob:",
  "frame-src 'self' about: forma-preview:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), {
    name: 'forma-content-policy',
    apply: 'build',
    transformIndexHtml: () => [{
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: contentPolicy },
      injectTo: 'head-prepend',
    }],
  }],
  test: {
    environment: 'jsdom',
    globals: true,
  },
  optimizeDeps: {
    include: ['exceljs', 'jszip', 'docx', 'mammoth', 'marked'],
  },
});
