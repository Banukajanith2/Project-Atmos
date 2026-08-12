import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs. This is a GitHub Pages *project* site, served from
  // /Project-Atmos/ rather than the domain root, so the default absolute "/"
  // base would point every asset at banukajanith2.github.io/assets/... and 404.
  // "./" resolves against the document instead, so the same build works at the
  // repo subpath, at a domain root, and on any other static host. There is no
  // client-side routing here, which is the one case relative base breaks.
  base: './',
  server: { port: 5173 },
});
