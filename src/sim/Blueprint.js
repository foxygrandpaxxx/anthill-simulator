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
  chamberSpacingY: 9, // baseline branch distance (must exceed no-overlap spacing)
  chamberRX: 3, // horizontal radius (x)
  chamberRZ: 3, // horizontal radius (z)
  chamberRY: 2, // vertical radius (oblate: flatter than wide)
  chamberSizeVar: 0.28, // ± fraction of random radius variation per chamber
  bedrockMargin: 3, // stop digging this many voxels above the lowest soil
  surfaceMargin: 4, // keep chamber centres at least this far below the surface
  // Branching growth — distinct round chambers joined by clean corridors.
  branchTries: 22, // candidate placements considered per new chamber
  minSeparation: 2.9, // min centre spacing (× radius) so chambers never overlap
  downwardBias: 0.45, // 0..1 how strongly new chambers tend deeper vs outward
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

  _addChamberAt(cx, cy, cz, type, rxIn, ryIn, rzIn) {
    const rx = rxIn || this.cfg.chamberRX;
    const ry = ryIn || this.cfg.chamberRY;
    const rz = rzIn || this.cfg.chamberRZ;
    const cells = [];
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dz = -rz; dz <= rz; dz++) {
        for (let dx = -rx; dx <= rx; dx++) {
          if ((dx / rx) ** 2 + (dy / ry) ** 2 + (dz / rz) ** 2 > 1.0) continue;
          const x = cx + dx, y = cy + dy, z = cz + dz;
          if (!this.world.inBounds(x, y, z)) continue;
          if (this.world.get(x, y, z) === Material.ROCK) continue;
          cells.push([x, y, z]);
          this._plan(x, y, z);
        }
      }
    }
    // Slots = the chamber floor (lowest 1–2 layers) where brood/food rests.
    let minY = Infinity;
    for (const [, y] of cells) if (y < minY) minY = y;
    const slots = cells.filter(([, y]) => y <= minY + 1);

    const cellIdx = new Set(cells.map(([x, y, z]) => this._idx(x, y, z)));
    const chamber = { type, cx, cy, cz, rx, ry, rz, cells, slots, cellIdx };
    this.chambers.push(chamber);
    return chamber;
  }

  // Grow the nest organically: branch a new chamber off an existing one in a
  // direction that spreads into open soil, so a thriving colony fills the tank
  // with an elaborate, sprawling network. Returns the chamber, or null if there
  // is nowhere left to dig (the nest has saturated the tank).
  addChamber(type) {
    const cfg = this.cfg;
    const W = this.world;
    const rBase = cfg.chamberRX;
    let best = null, bestScore = -Infinity;

    // Branch only off chambers whose air is genuinely reachable from the
    // entrance, so the new corridor always connects to the live nest (never
    // strands behind food or undug soil).
    const reached = this._reachableAirSet();
    const live = this.chambers.filter(
      (c) => c.cells.some(([x, y, z]) => reached.has(this._idx(x, y, z))),
    );
    // Nurseries cluster near the queen: branch them off existing nurseries so
    // brood stays close to the founding chamber. Granaries branch off anything.
    let pool = live.length ? live : this.chambers;
    if (type === "nursery") {
      const nurs = pool.filter((c) => c.type === "nursery");
      if (nurs.length) pool = nurs;
    }

    // Centroid of the nest, so we can push new chambers outward to fill the tank.
    let ccx = 0, ccz = 0;
    for (const c of this.chambers) { ccx += c.cx; ccz += c.cz; }
    ccx /= this.chambers.length; ccz /= this.chambers.length;

    for (let i = 0; i < cfg.branchTries; i++) {
      const parent = pool[(Math.random() * pool.length) | 0];
      // Bias the branch direction outward (away from the nest centroid) so the
      // nest expands into open ground rather than overlapping its own cluster.
      const outward = Math.atan2(parent.cz - ccz, parent.cx - ccx);
      const ang = outward + (Math.random() - 0.5) * Math.PI * 1.1;
      const len = cfg.chamberSpacingY * (0.85 + Math.random() * 0.9);
      const down = cfg.downwardBias + Math.random() * (1 - cfg.downwardBias);
      const out = Math.sqrt(Math.max(0, 1 - down * down));
      const x = Math.round(parent.cx + Math.cos(ang) * out * len);
      const z = Math.round(parent.cz + Math.sin(ang) * out * len);
      const y = Math.round(parent.cy - down * len);

      if (x < rBase + 1 || x > W.sx - rBase - 2) continue;
      if (z < rBase + 1 || z > W.sz - rBase - 2) continue;
      if (y - cfg.chamberRY < this.minDigY) continue;
      if (y > this.surfaceY - cfg.surfaceMargin) continue;

      // Spread: prefer spots far from existing chambers (vertical distance
      // weighted so chambers stack in layers rather than merging).
      let minD = Infinity;
      for (const c of this.chambers) {
        const d = Math.hypot(c.cx - x, (c.cy - y) * 1.4, c.cz - z);
        if (d < minD) minD = d;
      }
      if (minD < rBase * cfg.minSeparation) continue; // would overlap a chamber
      // Prefer CLOSE placements: short corridors dig reliably, and the nest
      // grows outward as a dense connected network rather than jumping to
      // distant deep spots whose long tunnels strand.
      const score = -minD + Math.random() * 3;
      if (score > bestScore) { bestScore = score; best = { parent, x, y, z }; }
    }

    if (!best) return null;
    const v = cfg.chamberSizeVar;
    const jitter = () => 1 + (Math.random() * 2 - 1) * v;
    // Start the corridor at an entrance-reachable air cell of the parent nearest
    // the target, so the new chamber's planned cells are guaranteed reachable.
    let start = null, sBest = Infinity;
    for (const [x, y, z] of best.parent.cells) {
      if (!reached.has(this._idx(x, y, z))) continue;
      const d = Math.abs(x - best.x) + Math.abs(y - best.y) + Math.abs(z - best.z);
      if (d < sBest) { sBest = d; start = [x, y, z]; }
    }
    if (!start) return null; // parent not actually reachable; skip this round
    this._planCleanTunnel(start[0], start[1], start[2], best.x, best.y, best.z);
    return this._addChamberAt(
      best.x, best.y, best.z, type,
      Math.max(2, Math.round(cfg.chamberRX * jitter())),
      Math.max(1, Math.round(cfg.chamberRY * jitter())),
      Math.max(2, Math.round(cfg.chamberRZ * jitter())),
    );
  }

  // Carve a clean 1-voxel corridor from (x0..) to (x1..): a straight vertical
  // run, then a straight run in x, then in z — orderly, face-contiguous, like
  // real ant-nest tunnels. Detours minimally around rock.
  _planCleanTunnel(x0, y0, z0, x1, y1, z1) {
    const W = this.world;
    const cl = (v, hi) => Math.max(1, Math.min(hi, v));
    let x = x0, y = y0, z = z0;
    for (const axis of [1, 0, 2]) { // y, then x, then z
      let guard = 0;
      while (guard++ < 120) {
        const cur = axis === 0 ? x : axis === 1 ? y : z;
        const tgt = axis === 0 ? x1 : axis === 1 ? y1 : z1;
        if (cur === tgt) break;
        this._plan(x, y, z);
        let nx = x, ny = y, nz = z;
        if (axis === 0) nx = cl(x + Math.sign(x1 - x), W.sx - 2);
        else if (axis === 1) ny = cl(y + Math.sign(y1 - y), W.sy - 2);
        else nz = cl(z + Math.sign(z1 - z), W.sz - 2);
        if (W.get(nx, ny, nz) === Material.ROCK) {
          // step around the rock perpendicular, keeping the path contiguous
          let routed = false;
          for (const [ax, ay, az] of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]) {
            const tx = cl(x + ax, W.sx - 2), ty = cl(y + ay, W.sy - 2), tz = cl(z + az, W.sz - 2);
            if (W.get(tx, ty, tz) !== Material.ROCK) { nx = tx; ny = ty; nz = tz; routed = true; break; }
          }
          if (!routed) break;
        }
        x = nx; y = ny; z = nz;
      }
    }
    this._plan(x1, y1, z1);
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

  // Set of all air cells reachable from the entrance through air (the live,
  // walkable nest). Used to guarantee new chambers connect to it.
  _reachableAirSet() {
    const W = this.world, e = this.entrance;
    const set = new Set();
    if (W.get(e.x, e.y, e.z) !== Material.AIR) return set;
    const maxY = e.y; // don't flood up into the open sky — only the nest
    set.add(this._idx(e.x, e.y, e.z));
    const q = [[e.x, e.y, e.z]];
    let h = 0;
    const N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    while (h < q.length) {
      const [x, y, z] = q[h++];
      for (const [dx, dy, dz] of N) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (!W.inBounds(nx, ny, nz) || ny > maxY) continue;
        const k = this._idx(nx, ny, nz);
        if (set.has(k)) continue;
        if (W.get(nx, ny, nz) === Material.AIR) { set.add(k); q.push([nx, ny, nz]); }
      }
    }
    return set;
  }

  // Self-heal: any chamber that's been excavated but is no longer connected to
  // the entrance gets a fresh corridor carved back to the nearest connected
  // chamber, so the nest can never end up with stranded disconnected pockets.
  reconnectStranded() {
    const reached = this._reachableAirSet();
    const connected = [], stranded = [];
    for (const c of this.chambers) {
      const dug = c.cells.some(([x, y, z]) => this.world.get(x, y, z) === Material.AIR);
      if (!dug) continue;
      const isReached = c.cells.some(([x, y, z]) => reached.has(this._idx(x, y, z)));
      (isReached ? connected : stranded).push(c);
    }
    for (const c of stranded) {
      let best = null, bd = Infinity;
      for (const rc of connected) {
        const d = Math.abs(rc.cx - c.cx) + Math.abs(rc.cy - c.cy) + Math.abs(rc.cz - c.cz);
        if (d < bd) { bd = d; best = rc; }
      }
      if (!best) continue;
      let start = null, sb = Infinity;
      for (const [x, y, z] of best.cells) {
        if (!reached.has(this._idx(x, y, z))) continue;
        const d = Math.abs(x - c.cx) + Math.abs(y - c.cy) + Math.abs(z - c.cz);
        if (d < sb) { sb = d; start = [x, y, z]; }
      }
      if (start) this._planCleanTunnel(start[0], start[1], start[2], c.cx, c.cy, c.cz);
    }
    return stranded.length;
  }

  onDug(x, y, z) {
    this.pending.delete(this._idx(x, y, z));
  }

  // Drop planned cells that can't actually be reached from the entrance (e.g. a
  // chamber whose corridor got boxed in by rock). Floods through air + still-
  // planned soil; anything not connected is pruned so it can't clog expansion.
  pruneStranded(start) {
    const W = this.world;
    const startK = this._idx(start[0], start[1], start[2]);
    const reached = new Set([startK]);
    const q = [start];
    let h = 0;
    const N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    while (h < q.length) {
      const [x, y, z] = q[h++];
      for (const [dx, dy, dz] of N) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (!W.inBounds(nx, ny, nz)) continue;
        const k = this._idx(nx, ny, nz);
        if (reached.has(k)) continue;
        if (W.get(nx, ny, nz) === Material.AIR || this.pending.has(k)) {
          reached.add(k);
          q.push([nx, ny, nz]);
        }
      }
    }
    let pruned = 0;
    for (const k of this.pending) if (!reached.has(k)) { this.pending.delete(k); pruned++; }
    this._removeDeadChambers();
    return pruned;
  }

  // Drop chambers that ended up with no live cells (none excavated and none
  // still pending) — e.g. one whose corridor never connected — so capacity
  // bookkeeping reflects what actually exists. The founding nursery is kept.
  _removeDeadChambers() {
    const kept = [];
    for (let i = 0; i < this.chambers.length; i++) {
      const c = this.chambers[i];
      let live = i === 0;
      if (!live) {
        for (const [x, y, z] of c.cells) {
          const m = this.world.get(x, y, z);
          if (m === Material.AIR || m === Material.STORE || this.pending.has(this._idx(x, y, z))) { live = true; break; }
        }
      }
      if (live) kept.push(c);
    }
    if (kept.length !== this.chambers.length) {
      this.chambers = kept;
      this._storeCellsAt = -1; // invalidate granary-cell cache
    }
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

  // Cells a granary may fill with food (piled on the floor, bottom-up). Only the
  // BOTTOM HALF (below the chamber's mid-height) is filled; the centre and top
  // stay open air so the connecting corridor (which meets the chamber at its
  // centre) never gets walled off by food and ants can always walk over the pile.
  // A chamber is filled only once fully excavated, so food can't block digging.
  storageFillCells() {
    const cells = [];
    for (const c of this.chambersOfType("storage")) {
      let incomplete = false;
      for (const [x, y, z] of c.cells) {
        if (this.pending.has(this._idx(x, y, z))) { incomplete = true; break; }
      }
      if (incomplete) continue; // still being dug — don't fill it yet
      for (const cell of c.cells) if (cell[1] < c.cy) cells.push(cell); // below mid-height
    }
    cells.sort((a, b) => a[1] - b[1]); // y ascending
    return cells;
  }

  // Total planned granary cells (dug or not) — used to stop over-planning storage.
  plannedStorageVoxels() {
    let n = 0;
    for (const c of this.chambersOfType("storage")) n += c.cells.length;
    return n;
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
