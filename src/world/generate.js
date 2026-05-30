import { World } from "./World.js";
import { Material } from "./materials.js";

// Small, fast, seedable PRNG (mulberry32).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cheap smooth 2D value noise built from the seeded RNG, used for the surface
// height and for scattering rock / food pockets.
function makeValueNoise2D(rand, period = 16) {
  const grid = new Map();
  const key = (ix, iz) => ix * 73856093 ^ iz * 19349663;
  const corner = (ix, iz) => {
    const k = key(ix, iz);
    let v = grid.get(k);
    if (v === undefined) {
      v = rand();
      grid.set(k, v);
    }
    return v;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, z) => {
    const fx = x / period;
    const fz = z / period;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = smooth(fx - ix);
    const tz = smooth(fz - iz);
    const v00 = corner(ix, iz);
    const v10 = corner(ix + 1, iz);
    const v01 = corner(ix, iz + 1);
    const v11 = corner(ix + 1, iz + 1);
    const a = v00 + (v10 - v00) * tx;
    const b = v01 + (v11 - v01) * tx;
    return a + (b - a) * tz;
  };
}

/**
 * Generate a randomly layered soil tank.
 *
 * Vertical layering from the surface down: topsoil → sand → clay → rock,
 * with a gently varying surface height and scattered rock + buried-food
 * pockets for natural variation.
 */
export function generateWorld({
  sx = 80,
  sy = 56,
  sz = 80,
  seed = (Math.random() * 1e9) | 0,
  surfaceFrac = 0.78, // average surface height as a fraction of sy
  surfaceVariation = 5, // +/- voxels of surface wobble
  topsoilDepth = 4,
  sandDepth = 10,
  clayDepth = 16,
  // remaining depth below clay becomes rock
  surfaceFoodClusters = 80, // food piles scattered across the surface (forage reserve)
  surfaceFoodClusterSize = 6,
} = {}) {
  const world = new World(sx, sy, sz);
  const rand = mulberry32(seed);
  const surfaceNoise = makeValueNoise2D(rand, 22);
  const rockNoise = makeValueNoise2D(rand, 7);
  const foodNoise = makeValueNoise2D(rand, 5);

  const baseSurface = Math.floor(sy * surfaceFrac);

  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      // Surface height for this column.
      const h =
        baseSurface +
        Math.round((surfaceNoise(x, z) - 0.5) * 2 * surfaceVariation);
      const surfaceY = Math.max(2, Math.min(sy - 1, h));

      for (let y = 0; y <= surfaceY; y++) {
        const depth = surfaceY - y; // 0 at surface, increasing downward
        let mat;
        if (depth < topsoilDepth) mat = Material.TOPSOIL;
        else if (depth < topsoilDepth + sandDepth) mat = Material.SAND;
        else if (depth < topsoilDepth + sandDepth + clayDepth) mat = Material.CLAY;
        else mat = Material.ROCK;

        // Scatter small, sparse rock pockets within the soil for natural
        // obstacles (kept rare so they don't engulf chambers).
        if (mat !== Material.ROCK && depth > 4) {
          const r = rockNoise(x + z * 0.5, z - y * 0.3) + (rand() - 0.5) * 0.1;
          if (r > 0.92) mat = Material.ROCK;
        }

        // Scatter buried food pockets through the soil (now also in clay, so
        // there's plenty of hidden food deep down to dig toward).
        if (
          mat === Material.SAND ||
          mat === Material.CLAY ||
          (mat === Material.TOPSOIL && depth >= 2)
        ) {
          const f = foodNoise(x - z * 0.4, z + y * 0.6);
          if (f > 0.84) mat = Material.FOOD;
        }

        world.set(x, y, z, mat);
      }
    }
  }

  // Scatter food on the surface: small clusters of FOOD voxels resting on top
  // of the terrain for foragers to gather.
  let surfaceFood = 0;
  const surfaceYAt = (x, z) => {
    for (let y = sy - 1; y >= 0; y--) {
      if (world.get(x, y, z) !== Material.AIR) return y;
    }
    return -1;
  };
  for (let c = 0; c < surfaceFoodClusters; c++) {
    const cxp = 4 + Math.floor(rand() * (sx - 8));
    const czp = 4 + Math.floor(rand() * (sz - 8));
    const count = 1 + Math.floor(rand() * surfaceFoodClusterSize);
    for (let k = 0; k < count; k++) {
      const x = Math.max(0, Math.min(sx - 1, cxp + Math.floor((rand() - 0.5) * 4)));
      const z = Math.max(0, Math.min(sz - 1, czp + Math.floor((rand() - 0.5) * 4)));
      const top = surfaceYAt(x, z);
      if (top >= 0 && top + 1 < sy && world.get(x, top + 1, z) === Material.AIR) {
        world.set(x, top + 1, z, Material.FOOD);
        surfaceFood++;
      }
    }
  }

  // Count total natural food in the world (surface + buried).
  let naturalFood = 0;
  for (let i = 0; i < world.voxels.length; i++) {
    if (world.voxels[i] === Material.FOOD) naturalFood++;
  }

  return { world, seed, naturalFood, surfaceFood };
}
