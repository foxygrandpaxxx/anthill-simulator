# 🐜 Anthill Simulator

A browser-based voxel ant-colony simulator. Watch a single founding ant dig a
nest, transform into a queen, raise brood, and grow an entire colony through a
found → grow → decline life cycle — all rendered as a 3D voxel cutaway you can
orbit and slice into. Pure client-side (Three.js); no server.

See [`DESIGN.md`](./DESIGN.md) for the full design, architecture, and the list
of tunable variables.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
```

## Build

```bash
npm run build    # outputs static files to dist/
npm run preview  # serve the production build locally
```

## Controls

- **Orbit / zoom / pan** — drag, scroll, right-drag
- **Cutaway** — pick an axis (X/Y/Z) and slide to slice into the nest
- **Speed** — pause / 1× / 4× / 16×
- **⚙ Tuning** — adjust colony variables live (forage yield, lay rate, lifespan…)
- **Click an ant or the queen** — inspect its live state
- **🍃 Drop food** — toggle on, then click the surface to add food

## Deploy (GitHub Pages)

This repo includes a GitHub Actions workflow (`.github/workflows/deploy.yml`)
that builds and deploys to GitHub Pages on every push to `main`.

1. Create a GitHub repo and push this project to it.
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main`. The site publishes at `https://<user>.github.io/<repo>/`.

The Vite `base` is relative (`./`), so it also works on Netlify, Vercel, or
Cloudflare Pages with build command `npm run build` and output directory `dist`.
