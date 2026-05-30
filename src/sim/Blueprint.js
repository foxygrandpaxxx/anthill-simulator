import { Material, isDiggable } from "../world/materials.js";

// ---------------------------------------------------------------------------
// The nest blueprint. An abstract plan — a central vertical shaft with oblate
// chambers branching off at regular depth intervals (the classic ant-nest
// morphology). Ants *realize* this plan block-by-block; the blueprint never
// digs. It only declares which solid voxels are "planned" (the dig frontier)
// and tracks chamber types/capacity. This is where the geometry's beauty and
// tunability live.
// ---------------------------------------------------------------------------

export const DEFAULT_BLUEPRINT_CONFIG = {
  firstChamberDepth: 7, // voxels below surface for the first chamber center
  chamberSpacingY: 6, // vertical interval between chambers
  chamberRX: 3, // horizontal radius (x)
  chamberRZ: 3, // horizontal radius (z)
  chamberRY: 2, // vertical radius (oblate: flatter than wide)
  branchReach: 4, // how far a chamber sits to the side of the shaft
  bedrockMargin: 3, // stop digging this many voxels above the lowest soil
};

export class Blueprint {
  constructor(world, entrance, surfaceY, cfg = {}) {
    this.world = world;
    this.cfg = { ...DEFAULT_BLUEPRINT_CONFIG, ...cfg };
    this.entrance = entrance; // {x,y,z} at the surface
    this.surfaceY = surfaceY;

    this.pending = new Set(); // world indices of planned, still-solid voxels
    this.chambers = [];
    this.shaftBottomY = surfaceY + 1; // grows downward as we extend
    this.minDigY = this._lowestSoilY() + this.cfg.bedrockMargin;
    this._sideToggle = 1;

    // Initial structure: a shaft down to the first chamber + a nursery there.
    // Guarantee this founding structure is always diggable (convert any rock in
    // it to clay) so a colony can never spawn doomed inside a rock blob.
    this._guaranteeDiggable = true;
    const firstY = surfaceY - this.cfg.firstChamberDepth;
    this._extendShaftTo(firstY);
    this._addChamberAt(entrance.x, firstY, entrance.z, "nursery");
    this._guaranteeDiggable = false;
  }

  // Find the world-y of the deepest soil column under the entrance (bedrock top).
  _lowestSoilY() {
    return 0; // bedrock sits at the bottom; we clamp digging with bedrockMargin
  }

  _idx(x, y, z) {
    return this.world.idx(x, y, z);
  }

  // Mark a voxel as planned. Only solid, diggable, in-bounds cells join the
  // pending dig set; rock is left alone (tunnels/chambers form around it).
  _plan(x, y, z) {
    if (!this.world.inBounds(x, y, z)) return;
    let m = this.world.get(x, y, z);
    // Founding structure must be carvable: turn rock into clay there.
    if (this._guaranteeDiggable && m === Material.ROCK) {
      this.world.set(x, y, z, Material.CLAY);
      m = Material.CLAY;
    }
    if (m === Material.ROCK || m === Material.FOOD || m === Material.STORE) return;
    if (isDiggable(m)) this.pending.add(this._idx(x, y, z));
    // (If already AIR, it's part of the structure but needs no digging.)
  }

  _extendShaftTo(targetY) {
    const { x, z } = this.entrance;
    for (let y = this.shaftBottomY; y >= targetY; y--) {
      // A 2-wide shaft reads better than a 1-voxel pinhole.
      this._plan(x, y, z);
      this._plan(x + 1, y, z);
    }
    this.shaftBottomY = Math.min(this.shaftBottomY, targetY);
  }

  // Carve a 1-voxel corridor from the shaft to a chamber center, nudging
  // around rock where possible.
  _planTunnel(x0, y0, z0, x1, y1, z1) {
    let x = x0, y = y0, z = z0;
    let guard = 0;
    while ((x !== x1 || y !== y1 || z !== z1) && guard++ < 200) {
      this._plan(x, y, z);
      const dx = Math.sign(x1 - x);
      const dz = Math.sign(z1 - z);
      const dy = Math.sign(y1 - y);
      // Prefer horizontal progress for a side branch, then settle vertically.
      let stepped = false;
      const tryStep = (nx, ny, nz) => {
        if (this.world.get(nx, ny, nz) === Material.ROCK) return false;
        x = nx; y = ny; z = nz; return true;
      };
      if (dx !== 0 && tryStep(x + dx, y, z)) stepped = true;
      else if (dz !== 0 && tryStep(x, y, z + dz)) stepped = true;
      else if (dy !== 0 && tryStep(x, y + dy, z)) stepped = true;
      if (!stepped) { // blocked by rock on the primary axis; force a move
        x += dx || 0; y += dy || 0; z += dz || 0;
      }
    }
    this._plan(x1, y1, z1);
  }

  _addChamberAt(cx, cy, cz, type) {
    const { chamberRX, chamberRY, chamberRZ } = this.cfg;
    const cells = [];
    for (let dy = -chamberRY; dy <= chamberRY; dy++) {
      for (let dz = -chamberRZ; dz <= chamberRZ; dz++) {
        for (let dx = -chamberRX; dx <= chamberRX; dx++) {
          const nx = (dx / chamberRX) ** 2;
          const ny = (dy / chamberRY) ** 2;
          const nz = (dz / chamberRZ) ** 2;
          if (nx + ny + nz > 1.0) continue;
          const x = cx + dx, y = cy + dy, z = cz + dz;
          if (!this.world.inBounds(x, y, z)) continue;
          if (this.world.get(x, y, z) === Material.ROCK) continue;
          cells.push([x, y, z]);
          this._plan(x, y, z);
        }
      }
    }

    // Slots = the lowest one or two layers (the chamber floor) where brood
    // rests or food is stacked.
    let minY = Infinity;
    for (const [, y] of cells) if (y < minY) minY = y;
    const slots = cells.filter(([, y]) => y <= minY + 1);

    const cellIdx = new Set(cells.map(([x, y, z]) => this._idx(x, y, z)));
    const chamber = { type, cx, cy, cz, cells, slots, cellIdx };
    this.chambers.push(chamber);
    return chamber;
  }

  // Add the next chamber down the shaft, alternating sides. Returns the chamber
  // or null if we've reached the digging floor (world saturation).
  addChamber(type) {
    const deepest = this.chambers.reduce(
      (m, c) => Math.min(m, c.cy),
      this.surfaceY,
    );
    const cy = deepest - this.cfg.chamberSpacingY;
    if (cy - this.cfg.chamberRY < this.minDigY) return null; // hit bedrock zone

    const side = this._sideToggle;
    this._sideToggle *= -1;
    const cx = this.entrance.x + side * this.cfg.branchReach;
    const cz = this.entrance.z;

    this._extendShaftTo(cy);
    this._planTunnel(this.entrance.x, cy, this.entrance.z, cx, cy, cz);
    return this._addChamberAt(cx, cy, cz, type);
  }

  // Carve an exploratory foraging gallery from the existing nest toward a
  // (usually hidden) target — e.g. a buried food deposit. The tunnel starts at
  // whichever existing chamber is closest to the target and bores toward it,
  // exposing the soil (and any food) it passes through. Returns true if planned.
  addForagingTunnel(target) {
    const w = this.world;
    const c = this.nestCenter();
    const before = this.pending.size;

    // Carve from the food back toward the nest, planning the solid soil gap
    // between them until we reach existing tunnels (air). This reliably exposes
    // the deposit no matter how the nest happens to be shaped.
    let x = target[0], y = target[1], z = target[2];
    let guard = 0;
    while (guard++ < 80) {
      const dx = Math.sign(c.x - x), dy = Math.sign(c.y - y), dz = Math.sign(c.z - z);
      if (dx === 0 && dy === 0 && dz === 0) break;
      const adx = Math.abs(c.x - x), ady = Math.abs(c.y - y), adz = Math.abs(c.z - z);
      let nx = x, ny = y, nz = z;
      if (adx >= ady && adx >= adz) nx += dx;
      else if (adz >= ady) nz += dz;
      else ny += dy;

      let m = w.get(nx, ny, nz);
      if (m === Material.ROCK) { // nudge around rock
        if (dz !== 0 && w.get(x, y, z + dz) !== Material.ROCK) { nx = x; ny = y; nz = z + dz; }
        else if (dx !== 0 && w.get(x + dx, y, z) !== Material.ROCK) { nx = x + dx; ny = y; nz = z; }
        else break;
        m = w.get(nx, ny, nz);
      }
      x = nx; y = ny; z = nz;
      if (m === Material.AIR) break; // reached the existing nest
      this._plan(x, y, z);
    }

    // Expose the deposit itself by planning its solid neighbours.
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      this._plan(target[0] + dx, target[1] + dy, target[2] + dz);
    }
    return this.pending.size > before;
  }

  onDug(x, y, z) {
    this.pending.delete(this._idx(x, y, z));
  }

  isPending(idx) {
    return this.pending.has(idx);
  }

  // A chamber slot is usable once its voxel has actually been excavated.
  _slotUsable(slot, wantMaterial) {
    const m = this.world.get(slot[0], slot[1], slot[2]);
    return m === wantMaterial;
  }

  chambersOfType(type) {
    return this.chambers.filter((c) => c.type === type);
  }

  // Air slots (excavated and ready to use right now).
  availableCapacity(type) {
    let n = 0;
    for (const c of this.chambersOfType(type)) {
      for (const s of c.slots) if (this._slotUsable(s, Material.AIR)) n++;
    }
    return n;
  }

  // Total slots in the plan for this type, excavated or not. Growth decisions
  // use this so we don't re-plan chambers faster than ants can dig them.
  plannedCapacity(type) {
    let n = 0;
    for (const c of this.chambersOfType(type)) n += c.slots.length;
    return n;
  }

  // The central nest reference point (first nursery, or entrance).
  nestCenter() {
    const nursery = this.chambersOfType("nursery")[0];
    if (nursery) return { x: nursery.cx, y: nursery.cy, z: nursery.cz };
    return this.entrance;
  }
}
