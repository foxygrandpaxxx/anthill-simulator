import { defineConfig } from "vite";

// Relative base so the built site works whether it's served from the domain
// root (Netlify/Vercel) or a project subpath like
// https://<user>.github.io/<repo>/ (GitHub Pages) — no repo name needed.
export default defineConfig({
  base: "./",
});
