# Anthill Simulator — Design Document

> **Status:** Prototype design, locked v0.1 (2026-05-29). Living document — expect to revise as the prototype teaches us things. Decisions here reflect deliberate choices made during design discussion; the rationale is recorded so future changes are informed rather than accidental.

---

## 1. Vision

A **voxel ant-colony simulator** that runs in the browser. The prototype is a **pure simulation toy**: you watch, hands-off, as a single founding ant builds an entire colony inside a randomly generated soil "tank" — digging beautiful, realistic tunnels, foraging food, transforming into a queen, and growing a colony that booms, plateaus, and gently winds down to a natural completion.

The aesthetic target is the look of a **real ant-nest cast** (the striking plaster/metal casts of excavated nests): near-vertical shafts, regularly spaced oblate chambers, clean organic branching.

**Prototype scope:** no human intervention required. The simulation is self-contained and self-completing. Future versions may add intervention (environmental variables, etc.) and many other features — explicitly out of scope for now, but the architecture leaves room.

### Design pillars
1. **Watchable, hands-off emergence** — a satisfying arc with a beginning (lone ant) and an end (world saturated / food exhausted).
2. **Beautiful, realistic tunnel geometry** — the single most important visual goal.
3. **Grounded in real ant biology, simplified** — believable systems, not a textbook.
4. **Everything tunable** — one config object drives the colony's "personality" so we can fine-tune playthroughs.

---

## 2. Player / viewer experience

- **Role:** observer of a living diorama. No required intervention in the prototype.
- **View:** a true **3D soil block** you orbit freely (rotate / zoom), with one or more **cutaway clipping planes** that slice away the front of the block to reveal the tunnel cross-section. A slider scans the cutaway plane deeper/shallower through the colony.
- **Surface:** ants forage on top; the excavated-dirt **spoil mound (tumulus)** accumulates around the entrance.
- **UI (thin):** time controls (pause / 1× / fast-forward), live stats (population, brood counts, stored food, food remaining in world), and the cutaway slider. *Future:* click an ant to inspect its state.

---

## 3. The colony life arc

The whole simulation is an **economy with one finite resource (food) and one effectively finite resource (diggable space).**

### 3.1 Founding (solo phase)
- One ant spawns on the surface of a freshly generated tank.
- She digs a starter shaft + small chamber, forages surface food, and discovers buried food pockets while digging.
- During founding she does **both** jobs (forage + dig). *(Real biology: the founder is already a queen who raises the first brood from body reserves. Our simplification — forage first, then become queen — is intentional: it gives a vulnerable lone-ant struggle that's more fun to watch.)*

### 3.2 Transformation
- On reaching a **founding food threshold**, the founder seals herself into the founding chamber (now the nursery), transforms into the **queen** — immobile from then on, she only lays eggs.

### 3.3 Growth loop (the heart)

```
food in world  --forage-->  stored food  --feeds-->  queen + larvae + workers
                                  |
                                  +--> egg-laying rate  (∝ surplus food, capped by nursery space)
                                              |
                            eggs -> larvae -> pupae -> workers
                                              |
                              workers -> forage  +  dig (haul dirt out, make space)
```

**Coupled feedback loops:**
- **Boom (positive):** more food → more eggs → more workers → more foraging *and* digging → more food + space → more eggs. The exponential takeoff.
- **Brakes (negative, self-limiting):**
  - More members → more consumption → less surplus → fewer eggs.
  - Brood ≤ **nursery capacity**; stored food ≤ **storage capacity** → growth *requires* digging, and digging requires workers you only get by growing. The colony paces itself.

### 3.4 Twilight / completion
- Workers **age and die** (bodies are carried out / become part of the world).
- The arc ends naturally when **environmental food is exhausted** (colony plateaus, then gently declines) **or** the **diggable world saturates** (no room to expand without wrecking the geometry).
- Result: a satisfying "the colony has reached its limit" end state, not an abrupt stop.

---

## 4. World model

- A **3D grid of voxels**, divided into **chunks**. Source of truth; knows nothing about graphics.
- Stored as **typed arrays** of material IDs for performance.
- **Materials:** `air`, `topsoil`, `sand`, `clay`, `rock/bedrock` (undiggable), `food` (buried pockets), plus surface `food` items.
- **Soil layering:** randomly generated layers (topsoil → sand → clay → bedrock at the bottom). Rock pockets scattered for natural variation and as undiggable obstacles that the nest geometry must route around.
- **Target size:** ~96×96×64 voxels (tune after Phase 1 — big enough for a real nest network, small enough to stay smooth).

---

## 5. Tunnel geometry — the "blueprint-guided" approach

**Chosen approach:** an organic **nest blueprint** grown from colony needs, **realized block-by-block by emergent ant labor.** This gives the cast-nest aesthetic *and* full tunability *and* the "watch it emerge" feeling — avoiding the amorphous-blob failure mode of pure stigmergy.

- The colony maintains an abstract **nest plan**: a growing **graph** where **nodes = chambers**, **edges = tunnels/shafts**. Lives in sim space, not voxel space.
- The plan **grows in response to need**:
  - Nursery full → sprout a new chamber node off the nearest tunnel at an appropriate depth.
  - Storage full → add a storage chamber.
  - Need to go deeper → extend a shaft.
  - Every chamber exists *because the colony needed it* — the geometry is meaningful.
- Planned shapes are **parametric** (and thus tunable):
  - **Chamber** = slightly noised **oblate ellipsoid** (wider than tall, like real chambers), radius `R`.
  - **Shaft** = near-vertical line with gentle Perlin **wander**, width 1.
  - **Branches** leave at controlled **angles**; chambers spaced at a set **vertical interval**.
- **Ants realize the plan** by excavating frontier voxels one at a time and hauling them up. Shape is guaranteed pretty and consistent; building is fully emergent, gradual, watchable. Bedrock/rock is respected as undiggable, forcing natural detours.

*(Alternative considered: pure stigmergy / local-rule digging. More authentically emergent but very hard to make consistently beautiful or to tune. Rejected for the prototype.)*

---

## 6. Mass balance (block conservation)

- Dirt is **conserved**. Digging = an ant **picks up** a voxel, **carries it up** the tunnel, and **dumps it** on the surface.
- Excavated material accumulates into a realistic **tumulus** (crater-rim mound) around the entrance. Total mound volume ≈ total tunnel volume at saturation.
- Hauling makes digging **visibly costly** (ants spend time carrying), naturally rate-limiting expansion.
- **Food is the exception** — it is consumed and vanishes.
- Dead worker bodies are carried out (and/or become inert voxels) — TBD detail in implementation.

---

## 7. Castes & life cycle

- **Queen:** immobile after transformation; consumes food at a high rate; lays eggs at a rate ∝ food surplus, capped by available nursery space.
- **Brood:** `egg → larva → pupa → worker`, each stage with a duration timer. Larvae consume stored food (nursing demand).
- **Workers:** forage and dig. Have a **lifespan** and die of old age.
  - *Room to grow:* age-based role assignment (temporal polyethism — young nurse, middle-aged build, old forage) is a natural future extension. Prototype may start with a simpler forage/dig split.

---

## 8. Food

- **Both surface and buried.** Food scattered on the surface (forage trips) **and** pockets buried in the soil (discovered while digging). Matches the founder "dig a chamber and find food" + workers "forage on the surface."
- Foraged/discovered food is hauled to **storage chambers** as blocks; storage is capped by storage-chamber capacity.
- Stored food is consumed by queen, larvae, and workers over time, and spent on egg-laying.
- Total environmental food is **finite**, set at world generation — its exhaustion is a primary completion condition.

---

## 9. Architecture

Three decoupled layers + thin UI. The separation is what makes "room to grow" real — new systems (seasons, predators, rival colonies, intervention) are added in the sim layer without touching rendering.

1. **World model** — plain voxel data (typed arrays, chunks). No graphics dependency.
2. **Simulation** — pure logic on a **fixed tick**: ant state (position, age, role, hunger, task, path), queen, brood + stage timers, food stores, nest plan, need/task signals. Unit-testable and tunable in isolation. Can move to a **Web Worker** later if it gets heavy — without touching other layers.
3. **Renderer** — reads model + sim, draws: face-culled chunk meshes, **instanced** ant mesh (cheap even at thousands), cutaway clipping plane, orbit camera. Read-only.
4. **UI** — time controls, stats readout, cutaway slider. *Future:* click-to-inspect.

### Pathfinding
- Target scale is **hundreds** of individually-simulated ants → real 3D graph search through the tunnel network is affordable and sells the "intelligent" feel. Preferred over pheromones for this depth-first design.
- *Implementation note (Phase 2):* started with **breadth-first search** over walkable air cells. On a uniform-cost grid BFS yields the same shortest paths as A\* and conveniently doubles as the frontier explorer for choosing dig/deposit targets (it returns reachability + parent pointers in one pass). Upgrade to weighted A\* later only if costs become non-uniform.

### Cutaway rendering (implementation note, Phase 1)
- The doc originally assumed **GPU clipping planes**. Implemented instead as a **voxel-native cutaway**: the mesher treats voxels past the cut threshold as empty and exposes the faces behind them. This avoids the "hollow shell" artifact (clipping a face-culled surface shows nothing where you slice through solid soil) and yields a true solid blocky cross-section that matches the voxel aesthetic. Bonus: it reuses the exact re-meshing path that digging needs.

### Tech stack
- **Three.js** (WebGL) — standard, mature, runs everywhere.
- Voxel rendering uses **per-chunk face-culled meshing** (never one cube per voxel); only changed chunks re-mesh on digging.
- Plain client-side web app; no server, no special hardware.

---

## 10. Tunable variables (the config object)

All exposed in one place so we can dial the colony's personality (frantic boom-bust ↔ slow stately cathedral-builder).

**World**
- dimensions (x, y, z)
- soil-layer depths (topsoil / sand / clay / bedrock)
- rock density
- food abundance & distribution (surface vs buried split)

**Economy**
- forage rate (food gathered per forager per unit time)
- consumption rates (queen / larva / worker, separately)
- food → egg conversion cost
- founding food threshold (solo → queen)

**Development**
- egg / larva / pupa stage durations
- worker lifespan

**Labor**
- dig speed, haul speed
- forage vs dig split (or age-based assignment)

**Geometry**
- chamber radius `R`
- chamber vertical spacing / interval
- shaft verticality & wander amount
- branch angle
- max nursery / storage capacity per chamber

**Sim**
- tick rate
- time-scale / fast-forward multipliers

---

## 11. Build phases

Vertical slices — each runnable and watchable on its own.

- **Phase 1 — The tank.** ✅ *Done.* Three.js scene; randomly generated 3D soil block with layered materials; face-culled meshing; orbit camera; working voxel-native cutaway + axis selector + depth slider; regenerate. (Single-geometry mesher for now; chunked meshing is a later optimization.)
- **Phase 2 — Digging & moving ants.** A few ants that wander and excavate voxels with 3D pathfinding through the tunnels they create; dirt hauled out to a spoil mound (new `SPOIL` material). *Proves the core agent+world loop and mass balance.* Ant behavior is a simple state machine (plan → move → dig / deposit); real purposeful geometry waits for the Phase 3 blueprint.
- **Phase 3 — The colony comes alive.** Founder→queen transformation; full brood life cycle; nursery/storage chambers via the nest blueprint; hunger; foraging (surface + buried); food-gated egg-laying; worker aging/death; the found→grow→decline arc. ✅ *Done (v1, tunable).* Verified numerically (full arc) + via WebGL pixel readback (scene renders).

  **Phase 3 implementation notes & decisions:**
  - *Movement:* walkability = air cell with a face-adjacent solid (ants cling to floors/walls); **18-connectivity** movement so ants climb steps. A trapped ant is relocated to the entrance after repeated planning failures (safety net).
  - *Pathfinding at scale:* per-ant flood BFS didn't scale (~47 ms/step at 15 ants). Replaced with **one shared BFS flood from the entrance**, refreshed every ~18 ticks, yielding a routing tree + nearest-first food/dig/deposit target lists reused by all ants (~2 ms/step at 100+ ants).
  - *Founding robustness:* the founding shaft + first nursery are force-converted from rock to clay so a colony can never spawn doomed inside a rock blob; rock is otherwise small/sparse.
  - *Economy balancing (the hard part):* growth is paced by (a) **lay restraint** — the queen keeps a base reserve plus a buffer per existing brood, so she never lays mouths she can't feed; and (b) a **hard floor on the lay interval** so the colony can't overshoot food faster than the ~maturation feedback loop. The queen is immune to starvation (a crash contracts, doesn't wipe out). All knobs live in `DEFAULT_SIM_CONFIG` / `DEFAULT_BLUEPRINT_CONFIG`.
  - *Known caveat (future pass):* the colony exhausts *reachable* food (surface + buried exposed by digging) then declines, while deeper untunneled buried food remains. Arc reads found → grow (~100 ants) → gradual decline. Tunneling toward remaining food, or treating reachable-food exhaustion as the "Twilight" trigger, is a future refinement.
  - *Renderer fix:* added a `ResizeObserver` (canvas was getting stuck at 0×0 when the page loaded at zero viewport size).
- **Phase 4 — Polish & observe.** ✅ *Done.* Time controls (pause/1×/4×/16×) + live stats; a **live Tuning panel** (forage yield, lay interval, worker lifespan, larva appetite, ant speed) that writes straight to `sim.cfg` and persists across regenerations; **click-to-inspect** any ant or the queen (raycast with cluster-sampling for the small targets; live readout of role/task/carrying/age/goal); a **Drop-food** tool (toggle, then click the surface to add food — the first taste of environmental intervention). Ants enlarged slightly for visibility/clickability. All verified via simulated DOM events (no screenshot tool needed).
- **Phase 5+ — Room to grow (future).** Human intervention (environmental variables), seasons, predators, rival colonies, water/flooding, additional species, age-based polyethism — to be decided.

---

## 12. Open questions / future decisions

- Exact representation of dead-ant bodies (inert voxel vs removed).
- Whether the prototype starts with a simple forage/dig labor split or jumps straight to age-based roles.
- Final world size and whether chunks/sim need a Web Worker at target ant counts.
- Performance ceiling exploration (how far past "hundreds" of ants we can push).
- Art direction details (voxel-blocky ants vs. something more detailed — leaning blocky for cohesion).

---

*End of v0.1.*
