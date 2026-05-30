// Material definitions for the voxel world.
// Material 0 is always AIR (empty). All others are solid.

export const Material = Object.freeze({
  AIR: 0,
  TOPSOIL: 1,
  SAND: 2,
  CLAY: 3,
  ROCK: 4, // undiggable bedrock / stones
  FOOD: 5, // natural food (surface + buried) that foragers harvest
  SPOIL: 6, // excavated dirt deposited on the surface (the tumulus / mound)
  STORE: 7, // food placed in storage chambers (visual representation of stores)
  CARCASS: 8, // a spawned bug (beetle/grasshopper) ants chip apart for food
});

// Base RGB colors (0..1), tuned for an earthy ant-farm cross-section look.
export const MATERIAL_COLOR = {
  [Material.TOPSOIL]: [0.34, 0.23, 0.13],
  [Material.SAND]: [0.74, 0.62, 0.40],
  [Material.CLAY]: [0.60, 0.40, 0.28],
  [Material.ROCK]: [0.42, 0.42, 0.44],
  [Material.FOOD]: [0.42, 0.70, 0.27],
  [Material.SPOIL]: [0.30, 0.20, 0.12], // freshly turned earth, slightly darker
  [Material.STORE]: [0.85, 0.70, 0.20], // stored food — warm gold, reads as a larder
  [Material.CARCASS]: [0.30, 0.42, 0.18], // bug — dark chitinous green
};

export function isSolid(m) {
  return m !== Material.AIR;
}

// Ants can excavate everything except air, rock (undiggable) and food
// (preserved for foraging in later phases). Spoil is diggable dirt.
export function isDiggable(m) {
  return m === Material.TOPSOIL || m === Material.SAND ||
    m === Material.CLAY || m === Material.SPOIL;
}
