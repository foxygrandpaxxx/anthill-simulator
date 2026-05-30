import { Material, isDiggable } from "../world/materials.js";
import { Blueprint } from "./Blueprint.js";

// ---------------------------------------------------------------------------
// Phase 3 simulation: a single founder grows a whole colony. Founder forages
// + digs the first chamber, transforms into a queen, lays food-gated eggs that
// mature egg→larva→pupa→worker; workers dig the nest blueprint and forage;
// food is consumed by the colony; chambers grow with need; workers age & die.
// Pure logic — mutates the world model, exposes state for the renderer.
// ---------------------------------------------------------------------------

export const DEFAULT_SIM_CONFIG = {
  simHz: 30,
  maxAnts: 400,
  maxBrood: 400,
  moveTicksPerCell: 4,
  digTicks: 12,
  harvestTicks: 10,
  navCap: 20000, // max cells explored by the shared navigation flood
  navRefreshTicks: 18, // how often the shared flood is rebuilt

  // Digging energy & nest expansion. Every excavated voxel spends food (energy),
  // so foraging fuels digging; the nest only sprawls when the colony is prosperous.
  digEnergyCost: 0.35, // food spent per voxel excavated
  expandInterval: 30, // ticks between expansion checks
  expandSurplus: 18, // spare food (above reserves) needed to grow the nest
  expandMaxPending: 90, // cap outstanding planned digging so it can't run away
  pruneInterval: 150, // ticks between pruning unreachable stranded plan cells

  // Surface food keeps trickling back so the tank has a carrying capacity
  // instead of starving to zero.
  foodRespawnInterval: 40, // ticks between new surface food drops
  foodRespawnClusterSize: 6,

  // Founding
  foundingThreshold: 10, // stored food needed before the founder becomes queen
  foundingMinNurserySlots: 4, // nursery slots dug before the founder may transform

  // Spoil mound (dirt disposal)
  depositRadiusMin: 4, // keep a clear apron around the entrance...
  depositRadiusMax: 11, // ...and spread spoil in a broad, low ring
  depositMaxHeight: 2, // low mound so it never walls ants in

  // Food economy (rates are per real second; converted by simHz)
  consumeQueen: 0.02,
  consumeWorker: 0.004,
  consumeLarva: 0.02,
  foodPerHarvest: 3, // food units gained per foraged item (a morsel feeds many)
  // Spawned bugs (carcasses): ants chip them apart slowly for a big payoff.
  carcassChipTicks: 30, // ticks to chip off one piece (slower than a forage)
  carcassFoodValue: 9, // food gained per carcass voxel chipped
  bugSize: 8, // roughly how long (in voxels) a spawned bug is
  eggCost: 1, // food spent to lay an egg
  layReserve: 5, // base food buffer the queen always keeps before laying
  broodBuffer: 2.0, // extra reserve required per existing brood (lay restraint)
  // A hard floor on the laying interval caps the growth rate so the colony
  // can't overshoot its food supply faster than the ~maturation feedback loop.
  // Equilibrium colony size ≈ (eggs/sec) × lifespan. These give ~300+.
  layIntervalBase: 3.5, // seconds between eggs at low food...
  layIntervalMin: 1.1, // ...down to this when food is plentiful
  layIntervalFoodScale: 0.04, // how strongly food shortens the interval

  // Brood development (seconds per stage)
  eggSeconds: 5,
  larvaSeconds: 10,
  pupaSeconds: 7,

  // Workers
  lifespanSeconds: 360,

  // Labor balance
  foragerFractionBase: 0.5,
  foragerFractionLowFood: 0.75,
  lowFoodLevel: 6,

  depositAnchorRadius: 3, // how close to the nest a forager must get to drop food
};

// Face neighbors (6): used for support detection and face-adjacent digging.
const FACE6 = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

// Movement neighbors (18 = faces + edges): lets ants climb steps and traverse
// diagonal wall/surface geometry. Excludes the 8 corner diagonals.
const MOVE18 = [];
for (let dx = -1; dx <= 1; dx++)
  for (let dy = -1; dy <= 1; dy++)
    for (let dz = -1; dz <= 1; dz++) {
      const m = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
      if (m === 1 || m === 2) MOVE18.push([dx, dy, dz]);
    }

const NEIGHBORS = FACE6; // alias for existing references

export class Simulation {
  constructor(world, gen, config = {}) {
    this.world = world;
    this.cfg = { ...DEFAULT_SIM_CONFIG, ...config };
    this.tick = 0;

    this.ants = [];
    this.brood = [];
    this.queen = null;
    this.occupiedSlots = new Set(); // nursery slot indices holding brood

    this.storedFood = 0; // float
    this.starveDebt = 0; // accumulates when food runs out, paces starvation deaths
    this.naturalFoodRemaining = gen ? gen.naturalFood : 0;

    this.dugCount = 0;
    this.depositCount = 0;
    this.deaths = 0;
    this.bornCount = 0;
    this.saturated = false;

    this.nav = null;
    this.claimed = new Set();

    this._initFounderAndBlueprint();
    this.rebuildNav();
  }

  // ---- setup -------------------------------------------------------------

  surfaceYAt(x, z) {
    for (let y = this.world.sy - 1; y >= 0; y--) {
      if (this.world.get(x, y, z) !== Material.AIR) return y;
    }
    return -1;
  }

  _initFounderAndBlueprint() {
    const { sx, sz } = this.world;
    const cx = Math.floor(sx / 2);
    const cz = Math.floor(sz / 2);
    const sy = this.surfaceYAt(cx, cz);
    this.entrance = { x: cx, y: sy + 1, z: cz };
    this.surfaceY = sy;

    this.blueprint = new Blueprint(this.world, this.entrance, sy, this.cfg.blueprint);

    const ant = makeAnt(0, cx, sy + 1, cz, "founder");
    this.ants.push(ant);
    this._nextId = 1;
  }

  // ---- world / movement helpers -----------------------------------------

  hasSolidNeighbor(x, y, z) {
    for (const [dx, dy, dz] of NEIGHBORS) {
      if (this.world.isSolidAt(x + dx, y + dy, z + dz)) return true;
    }
    return false;
  }

  walkable(x, y, z) {
    if (!this.world.inBounds(x, y, z)) return false;
    if (this.world.get(x, y, z) !== Material.AIR) return false;
    return this.hasSolidNeighbor(x, y, z);
  }

  // Find the nearest walkable cell to (x,y,z), preferring lower cells so a
  // stranded ant settles onto solid ground. Searches a small cube.
  nearestWalkable(x, y, z, maxR = 3) {
    let best = null;
    let bestScore = Infinity;
    for (let dy = -maxR; dy <= maxR; dy++) {
      for (let dz = -maxR; dz <= maxR; dz++) {
        for (let dx = -maxR; dx <= maxR; dx++) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (!this.walkable(nx, ny, nz)) continue;
          // prefer downward (settle), then closeness
          const score = (ny - y) * -2 + Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
          if (score < bestScore) { bestScore = score; best = [nx, ny, nz]; }
        }
      }
    }
    return best;
  }

  decode(key) {
    const { sx, sy } = this.world;
    return [key % sx, Math.floor(key / sx) % sy, Math.floor(key / (sx * sy))];
  }

  reconstruct(parent, targetCell) {
    const path = [];
    let k = this.world.idx(targetCell[0], targetCell[1], targetCell[2]);
    while (k !== -1 && k !== undefined) {
      path.push(this.decode(k));
      k = parent.get(k);
    }
    path.reverse();
    return path;
  }

  // Find the nearest reachable AIR cell whose 6-neighborhood contains a solid
  // voxel satisfying `pred(x,y,z,idx)`. BFS visits in distance order, so the
  // first hit is the closest frontier. Returns {stand, target, path} or null.
  frontierFind(start, pred) {
    const { world, cfg } = this;
    if (!this.walkable(start[0], start[1], start[2])) return null;
    const parent = new Map();
    parent.set(world.idx(...start), -1);
    const queue = [start];
    let head = 0;
    while (head < queue.length && head < cfg.bfsCap) {
      const [x, y, z] = queue[head++];
      // Detect targets only among face-adjacent solids (ants dig/grab cells
      // directly beside them, never through a diagonal gap).
      for (const [dx, dy, dz] of FACE6) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (!world.inBounds(nx, ny, nz)) continue;
        const m = world.get(nx, ny, nz);
        if (m !== Material.AIR && pred(nx, ny, nz, world.idx(nx, ny, nz))) {
          return {
            stand: [x, y, z],
            target: [nx, ny, nz],
            path: this.reconstruct(parent, [x, y, z]),
          };
        }
      }
      // Expand movement across faces + edges (climb steps).
      for (const [dx, dy, dz] of MOVE18) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (!this.walkable(nx, ny, nz)) continue;
        const k = world.idx(nx, ny, nz);
        if (parent.has(k)) continue;
        parent.set(k, world.idx(x, y, z));
        queue.push([nx, ny, nz]);
      }
    }
    return null;
  }

  // Find the nearest reachable AIR cell satisfying `cellPred(x,y,z)`.
  // Returns {cell, path} or null.
  reachableCell(start, cellPred) {
    const { world, cfg } = this;
    if (!this.walkable(start[0], start[1], start[2])) return null;
    const parent = new Map();
    parent.set(world.idx(...start), -1);
    const queue = [start];
    let head = 0;
    while (head < queue.length && head < cfg.bfsCap) {
      const [x, y, z] = queue[head++];
      if (!(x === start[0] && y === start[1] && z === start[2]) && cellPred(x, y, z)) {
        return { cell: [x, y, z], path: this.reconstruct(parent, [x, y, z]) };
      }
      for (const [dx, dy, dz] of MOVE18) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (!this.walkable(nx, ny, nz)) continue;
        const k = world.idx(nx, ny, nz);
        if (parent.has(k)) continue;
        parent.set(k, world.idx(x, y, z));
        queue.push([nx, ny, nz]);
      }
    }
    return null;
  }

  // ---- counts ------------------------------------------------------------

  broodCounts() {
    let egg = 0, larva = 0, pupa = 0;
    for (const b of this.brood) {
      if (b.stage === "egg") egg++;
      else if (b.stage === "larva") larva++;
      else pupa++;
    }
    return { egg, larva, pupa, total: this.brood.length };
  }

  workerCount() {
    return this.ants.length;
  }

  // ---- nursery slots -----------------------------------------------------

  freeNurserySlot() {
    for (const c of this.blueprint.chambersOfType("nursery")) {
      for (const s of c.slots) {
        const idx = this.world.idx(s[0], s[1], s[2]);
        if (this.occupiedSlots.has(idx)) continue;
        if (this.world.get(s[0], s[1], s[2]) === Material.AIR) {
          return { cell: s, idx };
        }
      }
    }
    return null;
  }

  freeNurserySlotCount() {
    let n = 0;
    for (const c of this.blueprint.chambersOfType("nursery")) {
      for (const s of c.slots) {
        const idx = this.world.idx(s[0], s[1], s[2]);
        if (this.occupiedSlots.has(idx)) continue;
        if (this.world.get(s[0], s[1], s[2]) === Material.AIR) n++;
      }
    }
    return n;
  }

  // ---- shared navigation flood ------------------------------------------
  //
  // One BFS from the entrance over all walkable air, refreshed every few ticks
  // and shared by every ant. It yields a routing tree to the entrance plus
  // nearest-first lists of food / dig / spoil-deposit targets. This replaces
  // per-ant flood searches (which don't scale) with a single shared one.

  rebuildNav() {
    const w = this.world, e = this.entrance, cfg = this.cfg;
    let start = [e.x, e.y, e.z];
    if (!this.walkable(...start)) start = this.nearestWalkable(e.x, e.y, e.z, 6) || start;

    const parent = new Map();
    parent.set(w.idx(...start), -1);
    const queue = [start];
    let head = 0;

    const foodTargets = [], digTargets = [], depositTargets = [], carcassTargets = [];
    const maxT = 300;
    const rmin = cfg.depositRadiusMin, rmax = cfg.depositRadiusMax;
    const maxDepY = this.surfaceY + cfg.depositMaxHeight;

    while (head < queue.length && head < cfg.navCap) {
      const [x, y, z] = queue[head++];
      const idxc = w.idx(x, y, z);

      // spoil-deposit candidate: this air cell rests on solid, in the apron ring
      if (depositTargets.length < maxT && w.isSolidAt(x, y - 1, z)) {
        const d = Math.abs(x - e.x) + Math.abs(z - e.z);
        if (d >= rmin && d <= rmax && y <= maxDepY) {
          const p = parent.get(idxc);
          if (p !== -1 && p !== undefined) depositTargets.push({ place: [x, y, z], stand: this.decode(p) });
        }
      }

      // face-adjacent harvest / dig targets
      for (const [dx, dy, dz] of FACE6) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (!w.inBounds(nx, ny, nz)) continue;
        const m = w.get(nx, ny, nz);
        if (m === Material.AIR) continue;
        if (m === Material.CARCASS) {
          carcassTargets.push({ stand: [x, y, z], target: [nx, ny, nz] }); // always tracked (high value)
        } else if (m === Material.FOOD) {
          if (foodTargets.length < maxT) foodTargets.push({ stand: [x, y, z], target: [nx, ny, nz] });
        } else if (digTargets.length < maxT && isDiggable(m) && this.blueprint.isPending(w.idx(nx, ny, nz))) {
          digTargets.push({ stand: [x, y, z], target: [nx, ny, nz] });
        }
      }

      // expand across faces + edges (climb steps)
      for (const [dx, dy, dz] of MOVE18) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (!this.walkable(nx, ny, nz)) continue;
        const k = w.idx(nx, ny, nz);
        if (parent.has(k)) continue;
        parent.set(k, idxc);
        queue.push([nx, ny, nz]);
      }
    }

    this.nav = { parent, foodTargets, digTargets, depositTargets, carcassTargets };
    this.claimed = new Set();
  }

  // Route from a cell back to the entrance via the nav tree. Null if the cell
  // wasn't reached by the last flood (disconnected / trapped).
  pathToStart(cell) {
    const w = this.world;
    let k = w.idx(cell[0], cell[1], cell[2]);
    if (!this.nav || !this.nav.parent.has(k)) return null;
    const path = [];
    while (k !== -1 && k !== undefined) { path.push(this.decode(k)); k = this.nav.parent.get(k); }
    return path; // cell ... entrance
  }

  // Full route ant -> entrance -> stand, using the shared tree.
  pathVia(ant, stand) {
    const toStart = this.pathToStart([ant.x, ant.y, ant.z]);
    const sToStart = this.pathToStart(stand);
    if (!toStart || !sToStart) return null;
    const rev = sToStart.slice().reverse(); // entrance ... stand
    return toStart.concat(rev.slice(1)); // ant ... entrance ... stand
  }

  _assignFromList(ant, list, validate, makeGoal) {
    let tried = 0;
    for (const t of list) {
      if (tried++ > 80) break;
      const key = t.target ? this.world.idx(...t.target) : this.world.idx(...t.place);
      if (this.claimed.has(key)) continue;
      if (!validate(t)) continue;
      const path = this.pathVia(ant, t.stand);
      if (!path) continue;
      this.claimed.add(key);
      ant.path = path;
      ant.pathIdx = 0;
      ant.goal = makeGoal(t);
      return true;
    }
    return false;
  }

  planForage(ant) {
    if (!this.nav) return false;
    const harvestGoal = (t) => ({ type: "forageHarvest", target: t.target });
    // A spawned bug is a high-value prize — go for it first.
    if (this.nav.carcassTargets.length &&
      this._assignFromList(ant, this.nav.carcassTargets,
        (t) => this.world.get(...t.target) === Material.CARCASS, harvestGoal)) return true;
    return this._assignFromList(
      ant, this.nav.foodTargets,
      (t) => this.world.get(...t.target) === Material.FOOD, harvestGoal,
    );
  }

  planDig(ant, idxFilter = null) {
    if (!this.nav) return false;
    return this._assignFromList(
      ant, this.nav.digTargets,
      (t) => {
        const idx = this.world.idx(...t.target);
        if (!this.blueprint.isPending(idx) || !isDiggable(this.world.get(...t.target))) return false;
        return idxFilter ? idxFilter(idx) : true;
      },
      (t) => ({ type: "dig", target: t.target }),
    );
  }

  planDepositDirt(ant) {
    if (!this.nav) return false;
    return this._assignFromList(
      ant, this.nav.depositTargets,
      (t) => this.world.get(...t.place) === Material.AIR && this.world.isSolidAt(t.place[0], t.place[1] - 1, t.place[2]),
      (t) => ({ type: "depositDirt", place: t.place }),
    );
  }

  planForageDeposit(ant) {
    const path = this.pathToStart([ant.x, ant.y, ant.z]);
    if (!path) return false;
    ant.path = path; // carry food back to the entrance/nest
    ant.pathIdx = 0;
    ant.goal = { type: "forageDeposit" };
    return true;
  }

  assignAndPlan(ant) {
    const cfg = this.cfg;
    const needForage = this.naturalFoodRemaining > 0;
    const needDig = this.blueprint.pending.size > 0;

    if (ant.role === "founder") {
      // Founder: excavate the nursery first (digging the shaft to reach it),
      // then forage up to the founding threshold.
      if (this.freeNurserySlotCount() < cfg.foundingMinNurserySlots) {
        const nurs = this.blueprint.chambersOfType("nursery")[0];
        if (this.planDig(ant, (idx) => nurs.cellIdx.has(idx))) { ant.task = "dig"; return; }
        if (this.planDig(ant)) { ant.task = "dig"; return; }
        if (needForage && this.planForage(ant)) { ant.task = "forage"; return; }
        this._planFailed(ant); return;
      }
      if (needForage && this.storedFood < cfg.foundingThreshold && this.planForage(ant)) {
        ant.task = "forage"; return;
      }
      if (this.planDig(ant)) { ant.task = "dig"; return; }
      if (this.planForage(ant)) { ant.task = "forage"; return; }
      this._planFailed(ant); return;
    }

    let want;
    if (needForage && needDig) {
      const frac = this.storedFood <= cfg.lowFoodLevel
        ? cfg.foragerFractionLowFood
        : cfg.foragerFractionBase;
      let foragers = 0;
      for (const a of this.ants) if (a.task === "forage") foragers++;
      want = foragers / Math.max(1, this.ants.length) < frac ? "forage" : "dig";
    } else if (needForage) want = "forage";
    else if (needDig) want = "dig";
    else { ant.idle = 30; ant.task = null; return; }

    let ok = want === "forage" ? this.planForage(ant) : this.planDig(ant);
    if (!ok) ok = want === "forage" ? this.planDig(ant) : this.planForage(ant);
    if (ok) ant.task = want;
    else this._planFailed(ant);
  }

  planAnt(ant) {
    if (ant.carrying === "dirt") {
      if (!this.planDepositDirt(ant)) this._planFailed(ant);
      return;
    }
    if (ant.carrying === "food") {
      if (!this.planForageDeposit(ant)) this._planFailed(ant);
      return;
    }
    this.assignAndPlan(ant);
  }

  // Called when an ant can reach nothing useful. After repeated failures it is
  // almost certainly trapped, so we relocate it to the entrance as a safety net.
  _planFailed(ant) {
    ant.task = null;
    ant.idle = 15;
    ant.stuck = (ant.stuck || 0) + 1;
    if (ant.stuck >= 4) {
      const e = this.entrance;
      const dest = this.nearestWalkable(e.x, e.y, e.z, 8) || [e.x, e.y, e.z];
      ant.px = ant.x; ant.py = ant.y; ant.pz = ant.z;
      ant.x = dest[0]; ant.y = dest[1]; ant.z = dest[2];
      ant.stuck = 0;
      ant.goal = null; ant.path = null;
    }
  }

  // ---- per-ant step ------------------------------------------------------

  completeAction(ant) {
    const g = ant.goal;
    if (!g) return;
    if (g.type === "dig") {
      const [x, y, z] = g.target;
      const idx = this.world.idx(x, y, z);
      if (this.blueprint.isPending(idx) && isDiggable(this.world.get(x, y, z))) {
        this.world.set(x, y, z, Material.AIR);
        this.world._dirty = true;
        this.blueprint.onDug(x, y, z);
        this.dugCount++;
        this.storedFood = Math.max(0, this.storedFood - this.cfg.digEnergyCost); // digging burns energy
        ant.carrying = "dirt";
      }
    } else if (g.type === "harvest") {
      const [x, y, z] = g.target;
      const m = this.world.get(x, y, z);
      if (m === Material.FOOD || m === Material.CARCASS) {
        this.world.set(x, y, z, Material.AIR);
        this.world._dirty = true;
        if (m === Material.FOOD) { this.naturalFoodRemaining--; ant.carryValue = this.cfg.foodPerHarvest; }
        else { ant.carryValue = this.cfg.carcassFoodValue; } // a chunk of bug is worth a lot
        ant.carrying = "food";
      }
    }
    ant.goal = null;
  }

  arriveAnt(ant) {
    const g = ant.goal;
    if (g.type === "dig") {
      const [x, y, z] = g.target;
      if (this.blueprint.isPending(this.world.idx(x, y, z)) && isDiggable(this.world.get(x, y, z))) {
        ant.actionTimer = this.cfg.digTicks;
        ant.actionGoal = g;
      } else ant.goal = null;
    } else if (g.type === "forageHarvest") {
      const [x, y, z] = g.target;
      const m = this.world.get(x, y, z);
      if (m === Material.FOOD || m === Material.CARCASS) {
        // Chipping a bug carcass takes much longer than picking up a morsel.
        ant.actionTimer = m === Material.CARCASS ? this.cfg.carcassChipTicks : this.cfg.harvestTicks;
        ant.actionGoal = { type: "harvest", target: g.target };
      } else ant.goal = null;
    } else if (g.type === "depositDirt") {
      const [x, y, z] = g.place;
      if (this.world.get(x, y, z) === Material.AIR && this.world.isSolidAt(x, y - 1, z)) {
        this.world.set(x, y, z, Material.SPOIL);
        this.world._dirty = true;
        this.depositCount++;
        ant.carrying = null;
        ant.task = null;
      }
      ant.goal = null;
    } else if (g.type === "forageDeposit") {
      this.storedFood += ant.carryValue || this.cfg.foodPerHarvest;
      ant.carryValue = 0;
      ant.carrying = null;
      ant.task = null;
      ant.goal = null;
    }
  }

  stepAnt(ant) {
    const cfg = this.cfg;
    if (ant.idle > 0) { ant.idle--; return; }

    // Unstick: digging/harvesting may have removed the support under an ant,
    // leaving it on a non-walkable cell. Relocate it to solid footing.
    if (!this.walkable(ant.x, ant.y, ant.z)) {
      const cell = this.nearestWalkable(ant.x, ant.y, ant.z, 3);
      if (cell) {
        ant.px = ant.x; ant.py = ant.y; ant.pz = ant.z;
        ant.x = cell[0]; ant.y = cell[1]; ant.z = cell[2];
      } else {
        ant.idle = 10;
      }
      ant.goal = null; ant.path = null; ant.actionTimer = 0;
      return;
    }

    if (ant.actionTimer > 0) {
      ant.actionTimer--;
      if (ant.actionTimer === 0) {
        ant.goal = ant.actionGoal || ant.goal;
        this.completeAction(ant);
        ant.actionGoal = null;
      }
      return;
    }

    if (!ant.goal || !ant.path) { this.planAnt(ant); return; }

    if (ant.pathIdx >= ant.path.length - 1) { this.arriveAnt(ant); return; }

    ant.moveCounter++;
    if (ant.moveCounter >= cfg.moveTicksPerCell) {
      ant.moveCounter = 0;
      const next = ant.path[ant.pathIdx + 1];
      if (!this.walkable(next[0], next[1], next[2])) {
        ant.goal = null; ant.path = null; return;
      }
      ant.px = ant.x; ant.py = ant.y; ant.pz = ant.z;
      ant.x = next[0]; ant.y = next[1]; ant.z = next[2];
      ant.pathIdx++;
      ant.stuck = 0; // made progress; not trapped
    }
  }

  // ---- colony systems ----------------------------------------------------

  tryTransformFounder() {
    if (this.queen) return;
    const founder = this.ants.find((a) => a.role === "founder");
    if (!founder) return;
    if (this.storedFood < this.cfg.foundingThreshold) return;
    if (this.freeNurserySlotCount() < this.cfg.foundingMinNurserySlots) return;
    const slot = this.freeNurserySlot();
    if (!slot) return; // nursery not excavated enough yet — keep digging

    // The founder seals in and becomes the immobile queen.
    this.queen = { x: slot.cell[0], y: slot.cell[1], z: slot.cell[2], layTimer: 0 };
    this.occupiedSlots.add(slot.idx); // the queen occupies her slot
    this.ants = this.ants.filter((a) => a !== founder);
  }

  layInterval() {
    const cfg = this.cfg;
    const t = cfg.layIntervalBase - this.storedFood * cfg.layIntervalFoodScale;
    return Math.max(cfg.layIntervalMin, t) * cfg.simHz;
  }

  updateQueen() {
    if (!this.queen) return;
    if (this.queen.layTimer > 0) { this.queen.layTimer--; return; }
    if (this.brood.length >= this.cfg.maxBrood) return;
    // Lay restraint: keep the base reserve PLUS a buffer for every mouth already
    // in the nursery. The queen won't add brood she can't yet feed, which
    // self-throttles laying and smooths the boom-bust into steady growth.
    const need = this.cfg.layReserve + this.brood.length * this.cfg.broodBuffer;
    if (this.storedFood <= need) return;
    const slot = this.freeNurserySlot();
    if (!slot) return;

    this.storedFood -= this.cfg.eggCost;
    this.occupiedSlots.add(slot.idx);
    this.brood.push(makeBrood(slot.cell, slot.idx, this.cfg.eggSeconds * this.cfg.simHz));
    this.queen.layTimer = this.layInterval();
  }

  updateBrood() {
    const cfg = this.cfg;
    const promote = [];
    for (const b of this.brood) {
      b.timer--;
      if (b.timer > 0) continue;
      if (b.stage === "egg") { b.stage = "larva"; b.timer = cfg.larvaSeconds * cfg.simHz; }
      else if (b.stage === "larva") { b.stage = "pupa"; b.timer = cfg.pupaSeconds * cfg.simHz; }
      else promote.push(b);
    }
    for (const b of promote) this._emergeWorker(b);
  }

  _emergeWorker(b) {
    this.occupiedSlots.delete(b.idx);
    this.brood.splice(this.brood.indexOf(b), 1);
    if (this.ants.length >= this.cfg.maxAnts) return;

    let spawn = [b.x, b.y, b.z];
    if (!this.walkable(...spawn)) {
      // find a nearby walkable cell
      let found = null;
      for (const [dx, dy, dz] of NEIGHBORS) {
        const c = [b.x + dx, b.y + dy, b.z + dz];
        if (this.walkable(...c)) { found = c; break; }
      }
      spawn = found || [this.entrance.x, this.entrance.y, this.entrance.z];
    }
    const ant = makeAnt(this._nextId++, spawn[0], spawn[1], spawn[2], "worker");
    this.ants.push(ant);
    this.bornCount++;
  }

  updateConsumption() {
    // The lone founder fends for itself; colony consumption begins at founding.
    if (!this.queen) return;
    const cfg = this.cfg;
    const counts = this.broodCounts();
    let perTick = cfg.consumeQueen;
    perTick += this.ants.length * cfg.consumeWorker;
    perTick += counts.larva * cfg.consumeLarva;
    perTick /= cfg.simHz;

    this.storedFood -= perTick;
    if (this.storedFood < 0) {
      // Bank the deficit and convert it into deaths at the rate it accrues,
      // so an exhausted colony declines gradually rather than collapsing.
      this.starveDebt += -this.storedFood;
      this.storedFood = 0;
      while (this.starveDebt >= 1) {
        if (!this._starve()) { this.starveDebt = 0; break; }
        this.starveDebt -= 1;
      }
    }
  }

  _starve() {
    // Starvation hits the most dependent first: larvae, then other brood,
    // then workers. The queen is the last to go. Returns false if nobody left.
    if (this.brood.length > 0) {
      let idx = this.brood.findIndex((b) => b.stage === "larva");
      if (idx < 0) idx = 0;
      const b = this.brood[idx];
      this.occupiedSlots.delete(b.idx);
      this.brood.splice(idx, 1);
      this.deaths++;
      return true;
    }
    if (this.ants.length > 0) {
      this.ants.pop();
      this.deaths++;
      return true;
    }
    // The queen endures: a food crash contracts the colony but doesn't wipe it
    // out. True extinction only comes from total wild-food exhaustion (twilight).
    return false;
  }

  updateAging() {
    const cfg = this.cfg;
    const lifespan = cfg.lifespanSeconds * cfg.simHz;
    const survivors = [];
    for (const a of this.ants) {
      if (a.role === "founder") { survivors.push(a); continue; } // founder is long-lived
      a.age++;
      if (a.age >= lifespan) { this.deaths++; continue; }
      survivors.push(a);
    }
    this.ants = survivors;
  }

  // Grow the nest. Two drivers, both gated by *energy* (spare food) so the nest
  // only sprawls when the colony is prosperous and digging is affordable:
  //  - need: add nursery/storage when brood/food approach capacity
  //  - ambition: when there's surplus, keep branching out to fill the tank
  updateGrowth() {
    if (this.tick % this.cfg.expandInterval !== 0) return;
    if (!this.queen || this.saturated) return;
    const bp = this.blueprint;
    if (bp.pending.size > this.cfg.expandMaxPending) return; // still plenty to dig

    const reserve = this.cfg.layReserve + this.ants.length * 0.5;
    const surplus = this.storedFood - reserve;
    if (surplus < this.cfg.expandSurplus) return; // not enough energy to dig

    const needNursery = this.brood.length >= bp.plannedCapacity("nursery") - 2;
    const needStorage = Math.floor(this.storedFood) >= bp.plannedCapacity("storage") - 1;
    let type;
    if (needNursery) type = "nursery";
    else if (needStorage) type = "storage";
    else type = Math.random() < 0.55 ? "nursery" : "storage"; // ambition: fill the tank
    if (bp.addChamber(type) === null) this.saturated = true;
  }

  // Trickle of new surface food so the tank has a steady carrying capacity.
  maybeRespawnFood() {
    if (this.tick % this.cfg.foodRespawnInterval !== 0) return;
    this.spawnSurfaceFoodCluster(this.cfg.foodRespawnClusterSize);
  }

  // Drop a small cluster of food on the surface at a random location.
  spawnSurfaceFoodCluster(size) {
    const w = this.world;
    const cx = 3 + ((Math.random() * (w.sx - 6)) | 0);
    const cz = 3 + ((Math.random() * (w.sz - 6)) | 0);
    const n = 1 + ((Math.random() * size) | 0);
    for (let k = 0; k < n; k++) {
      const x = Math.max(0, Math.min(w.sx - 1, cx + ((Math.random() - 0.5) * 5) | 0));
      const z = Math.max(0, Math.min(w.sz - 1, cz + ((Math.random() - 0.5) * 5) | 0));
      const top = this.surfaceYAt(x, z);
      if (top >= 0 && top + 1 < w.sy && w.get(x, top + 1, z) === Material.AIR) {
        w.set(x, top + 1, z, Material.FOOD);
        w._dirty = true;
        this.naturalFoodRemaining++;
      }
    }
  }

  // Spawn a "bug" (beetle/grasshopper) carcass on the surface: a clump of
  // high-value CARCASS voxels the ants must swarm and chip apart over time.
  spawnBug() {
    const w = this.world;
    // Land it within foraging range of the entrance so the colony actually
    // discovers it (and reacts to it), but still somewhat random.
    const R = 22;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const cx = clamp(this.entrance.x + Math.round((Math.random() - 0.5) * 2 * R), 4, w.sx - 5);
    const cz = clamp(this.entrance.z + Math.round((Math.random() - 0.5) * 2 * R), 4, w.sz - 5);
    const top = this.surfaceYAt(cx, cz);
    if (top < 0 || top + 1 >= w.sy) return false;
    // a short elongated body so it reads as a bug, sitting on the surface
    const len = this.cfg.bugSize;
    let placed = 0;
    for (let i = 0; i < len; i++) {
      const x = Math.max(0, Math.min(w.sx - 1, cx + i - ((len / 2) | 0)));
      const ty = this.surfaceYAt(x, cz);
      for (const dz of [0, i === 0 || i === len - 1 ? 0 : (Math.random() < 0.5 ? 1 : -1)]) {
        const z = Math.max(0, Math.min(w.sz - 1, cz + dz));
        if (w.get(x, ty + 1, z) === Material.AIR) { w.set(x, ty + 1, z, Material.CARCASS); placed++; }
      }
    }
    if (placed) w._dirty = true;
    return placed > 0;
  }

  reconcileFoodVoxels() {
    if (this.tick % 5 !== 0) return;
    const bp = this.blueprint;
    const slots = [];
    for (const c of bp.chambersOfType("storage")) for (const s of c.slots) slots.push(s);

    let visible = 0;
    for (const s of slots) if (this.world.get(s[0], s[1], s[2]) === Material.STORE) visible++;
    const target = Math.min(Math.floor(this.storedFood), slots.length);

    let budget = 6;
    if (visible < target) {
      for (const s of slots) {
        if (budget <= 0) break;
        if (this.world.get(s[0], s[1], s[2]) === Material.AIR) {
          this.world.set(s[0], s[1], s[2], Material.STORE);
          this.world._dirty = true;
          budget--; visible++;
          if (visible >= target) break;
        }
      }
    } else if (visible > target) {
      for (let i = slots.length - 1; i >= 0 && budget > 0; i--) {
        const s = slots[i];
        if (this.world.get(s[0], s[1], s[2]) === Material.STORE) {
          this.world.set(s[0], s[1], s[2], Material.AIR);
          this.world._dirty = true;
          budget--; visible--;
          if (visible <= target) break;
        }
      }
    }
  }

  phase() {
    if (!this.queen) return "Founding";
    if (this.naturalFoodRemaining <= 0 && this.saturated) return "Complete";
    if (this.naturalFoodRemaining <= 0) return "Twilight";
    return "Growing";
  }

  // ---- main tick ---------------------------------------------------------

  step() {
    this.tick++;
    if (this.tick % this.cfg.navRefreshTicks === 0) this.rebuildNav();
    this.tryTransformFounder();
    this.updateQueen();
    this.updateBrood();
    this.updateConsumption();
    this.updateAging();
    this.updateGrowth();
    if (this.tick % this.cfg.pruneInterval === 0) {
      this.blueprint.pruneStranded([this.entrance.x, this.entrance.y, this.entrance.z]);
    }
    this.maybeRespawnFood();
    this.reconcileFoodVoxels();
    for (const ant of this.ants) this.stepAnt(ant);
  }
}

function makeAnt(id, x, y, z, role) {
  return {
    id, role,
    x, y, z,
    px: x, py: y, pz: z,
    moveCounter: 0,
    path: null,
    pathIdx: 0,
    goal: null,
    actionTimer: 0,
    actionGoal: null,
    carrying: null, // null | 'dirt' | 'food'
    carryValue: 0, // food units in the currently-carried load
    task: null, // null | 'dig' | 'forage'
    idle: 0,
    age: 0,
  };
}

function makeBrood(cell, idx, timer) {
  return { stage: "egg", timer, idx, x: cell[0], y: cell[1], z: cell[2] };
}
