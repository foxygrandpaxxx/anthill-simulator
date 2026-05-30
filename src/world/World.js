import { Material } from "./materials.js";

// The voxel world model. Pure data — knows nothing about rendering.
// Coordinate convention: x = width, y = up (height), z = depth.
// Flat index: x + sx * (y + sy * z).
export class World {
  constructor(sx, sy, sz) {
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    this.voxels = new Uint8Array(sx * sy * sz); // defaults to AIR (0)
  }

  idx(x, y, z) {
    return x + this.sx * (y + this.sy * z);
  }

  inBounds(x, y, z) {
    return (
      x >= 0 && x < this.sx &&
      y >= 0 && y < this.sy &&
      z >= 0 && z < this.sz
    );
  }

  get(x, y, z) {
    if (!this.inBounds(x, y, z)) return Material.AIR;
    return this.voxels[this.idx(x, y, z)];
  }

  set(x, y, z, m) {
    if (!this.inBounds(x, y, z)) return;
    this.voxels[this.idx(x, y, z)] = m;
  }

  isSolidAt(x, y, z) {
    // Out of bounds counts as empty so the outer faces of the block render.
    if (!this.inBounds(x, y, z)) return false;
    return this.voxels[this.idx(x, y, z)] !== Material.AIR;
  }

  countSolid() {
    let n = 0;
    for (let i = 0; i < this.voxels.length; i++) if (this.voxels[i] !== 0) n++;
    return n;
  }
}
