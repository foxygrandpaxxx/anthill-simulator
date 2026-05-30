import { generateWorld } from "./world/generate.js";
import { Renderer } from "./render/Renderer.js";
import { Simulation, DEFAULT_SIM_CONFIG } from "./sim/Simulation.js";
import { Material } from "./world/materials.js";

const container = document.getElementById("app");
const renderer = new Renderer(container);
window.__renderer = renderer;

const cutSlider = document.getElementById("cut");
const cutVal = document.getElementById("cutVal");
const axisButtons = document.querySelectorAll("#axis button");
const speedButtons = document.querySelectorAll("#speed button");
const speedVal = document.getElementById("speedVal");
const regenBtn = document.getElementById("regen");
const phaseEl = document.getElementById("phase");
const statsEl = document.getElementById("stats");

let world = null;
let sim = null;
let cutAxis = "z";
let speed = 1;
let xray = false;

function axisSize(axis) {
  return axis === "x" ? world.sx : axis === "y" ? world.sy : world.sz;
}

function currentCut() {
  const pct = Number(cutSlider.value) / 100;
  const size = axisSize(cutAxis);
  return { axis: cutAxis, value: Math.round(pct * (size - 1)) };
}

function updateStats() {
  const b = sim.broodCounts();
  phaseEl.textContent = sim.phase();
  statsEl.innerHTML =
    `ants &nbsp; <b>${sim.ants.length}</b>${sim.queen ? " + queen" : " (founder)"}<br>` +
    `brood &nbsp; ${b.egg} egg · ${b.larva} larva · ${b.pupa} pupa<br>` +
    `stored food &nbsp; ${Math.floor(sim.storedFood)}<br>` +
    `food in world &nbsp; ${sim.naturalFoodRemaining}<br>` +
    `chambers &nbsp; ${sim.blueprint.chambers.length}<br>` +
    `excavated &nbsp; ${sim.dugCount.toLocaleString()} · born ${sim.bornCount} · died ${sim.deaths}<br>` +
    `seed &nbsp; ${world._seed}`;
}

function regenerate() {
  const result = generateWorld({ sx: 80, sy: 56, sz: 80 });
  world = result.world;
  world._seed = result.seed;
  world._dirty = false;

  sim = new Simulation(world, result);
  window.__sim = sim;
  window.__world = world;

  renderer.setWorld(world, currentCut());
  renderer.frameWorld(world);
  renderer.initColony(sim.cfg.maxAnts, sim.cfg.maxBrood);
  renderer.setXray(xray); // keep X-ray state across regenerations
  applyTuning(); // re-apply any tuned values onto the fresh sim
  selected = null;
  document.getElementById("inspect").classList.add("hidden");
  updateStats();
}

cutSlider.addEventListener("input", () => {
  cutVal.textContent = `${cutSlider.value}%`;
  renderer.rebuild(currentCut());
});

axisButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    axisButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    cutAxis = btn.dataset.axis;
    renderer.rebuild(currentCut());
  });
});

speedButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    speedButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    speed = Number(btn.dataset.mul);
    speedVal.textContent = speed === 0 ? "paused" : `${speed}×`;
  });
});

const xrayBtn = document.getElementById("xray");
xrayBtn.addEventListener("click", () => {
  xray = !xray;
  renderer.setXray(xray);
  xrayBtn.classList.toggle("active", xray);
  xrayBtn.textContent = `👁 X-ray: ${xray ? "on" : "off"}`;
});

regenBtn.addEventListener("click", regenerate);

document.getElementById("spawnBug").addEventListener("click", () => {
  if (sim) sim.spawnBug();
});

// --- Live tuning: bind [data-cfg] sliders to sim.cfg ----------------------
const tuningInputs = document.querySelectorAll("#tuningWrap input[data-cfg]");
function fmtTuning(input) {
  const v = Number(input.value);
  const span = document.querySelector(`.val[data-for="${input.dataset.cfg}"]`);
  if (span) span.textContent = input.dataset.invert ? (10 - v).toString() : input.value;
}
function applyTuning() {
  for (const input of tuningInputs) {
    sim.cfg[input.dataset.cfg] = Number(input.value);
    fmtTuning(input);
  }
}
// Initialize slider positions from the default config (source of truth).
tuningInputs.forEach((input) => {
  const k = input.dataset.cfg;
  if (DEFAULT_SIM_CONFIG[k] !== undefined) input.value = DEFAULT_SIM_CONFIG[k];
  fmtTuning(input);
});
tuningInputs.forEach((input) => {
  input.addEventListener("input", () => {
    if (sim) sim.cfg[input.dataset.cfg] = Number(input.value);
    fmtTuning(input);
  });
});

// --- Drop-food tool -------------------------------------------------------
const dropFoodBtn = document.getElementById("dropFood");
let dropFoodMode = false;
dropFoodBtn.addEventListener("click", () => {
  dropFoodMode = !dropFoodMode;
  dropFoodBtn.classList.toggle("active", dropFoodMode);
  dropFoodBtn.textContent = `🍃 Drop food: ${dropFoodMode ? "on" : "off"}`;
});

function dropFoodAt(clientX, clientY) {
  const cell = renderer.pickSurfaceCell(clientX, clientY);
  if (!cell) return;
  const [x, , z] = cell;
  if (x < 0 || x >= world.sx || z < 0 || z >= world.sz) return;
  const top = sim.surfaceYAt(x, z);
  if (top >= 0 && top + 1 < world.sy && world.get(x, top + 1, z) === Material.AIR) {
    world.set(x, top + 1, z, Material.FOOD);
    sim.naturalFoodRemaining++;
    world._dirty = true;
  }
}

// --- Click-to-inspect an ant or the queen ---------------------------------
const inspectEl = document.getElementById("inspect");
let selected = null; // { kind:'ant', ant } | { kind:'queen' }
const canvasEl = renderer.renderer.domElement;
let downX = 0, downY = 0;
canvasEl.addEventListener("pointerdown", (e) => { downX = e.clientX; downY = e.clientY; });
canvasEl.addEventListener("pointerup", (e) => {
  if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 6) return; // a drag, not a click
  if (dropFoodMode) { dropFoodAt(e.clientX, e.clientY); return; }
  const pick = renderer.pickColonist(e.clientX, e.clientY);
  if (!pick) { selected = null; inspectEl.classList.add("hidden"); return; }
  selected = pick.kind === "queen" ? { kind: "queen" } : { kind: "ant", ant: sim.ants[pick.id] };
  renderInspect();
});

function row(k, v) { return `<div><span class="k">${k}</span> &nbsp; ${v}</div>`; }
function renderInspect() {
  if (!selected) { inspectEl.classList.add("hidden"); return; }
  const close = `<span class="close" id="inspClose">✕</span>`;
  if (selected.kind === "queen") {
    if (!sim.queen) { selected = null; inspectEl.classList.add("hidden"); return; }
    const b = sim.broodCounts();
    inspectEl.innerHTML = `<h2>👑 Queen ${close}</h2>` +
      row("position", `${sim.queen.x},${sim.queen.y},${sim.queen.z}`) +
      row("stored food", Math.floor(sim.storedFood)) +
      row("brood", `${b.egg}e · ${b.larva}l · ${b.pupa}p`) +
      row("next egg in", `${Math.ceil(sim.queen.layTimer / sim.cfg.simHz)}s`);
  } else {
    const a = selected.ant;
    if (!a || !sim.ants.includes(a)) {
      inspectEl.innerHTML = `<h2>🐜 Worker ${close}</h2>` + row("status", "has died");
    } else {
      const lifePct = Math.min(100, Math.round((a.age / (sim.cfg.lifespanSeconds * sim.cfg.simHz)) * 100));
      inspectEl.innerHTML = `<h2>🐜 ${a.role === "founder" ? "Founder" : "Worker"} #${a.id} ${close}</h2>` +
        row("task", a.task || "idle") +
        row("carrying", a.carrying || "nothing") +
        row("age", `${lifePct}% of life`) +
        row("position", `${a.x},${a.y},${a.z}`) +
        row("goal", a.goal ? a.goal.type : "—");
    }
  }
  inspectEl.classList.remove("hidden");
  const c = document.getElementById("inspClose");
  if (c) c.onclick = () => { selected = null; inspectEl.classList.add("hidden"); };
}

regenerate();
applyTuning();

// --- Fixed-timestep simulation loop with speed multiplier ------------------
const SIM_DT = 1000 / DEFAULT_SIM_CONFIG.simHz;
const MAX_STEPS_PER_FRAME = 400; // safety cap at high speed
let last = performance.now();
let acc = 0;
let lastMeshMs = 0;

renderer.start(() => {
  const now = performance.now();
  let dt = now - last;
  last = now;
  if (dt > 250) dt = 250;
  acc += dt * speed;

  let steps = 0;
  try {
    while (acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      sim.step();
      acc -= SIM_DT;
      steps++;
    }
  } catch (err) {
    // Keep the app alive (camera + rendering) even if the sim hits a bug, so a
    // public demo never hard-freezes. Log once, then drop this frame's debt.
    if (!window.__simErrorLogged) { console.error("sim.step threw:", err); window.__simErrorLogged = true; }
    acc = 0;
  }
  if (steps >= MAX_STEPS_PER_FRAME) acc = 0; // don't accumulate debt

  // Re-mesh when the world changed, throttled to keep the framerate smooth.
  if (world._dirty && now - lastMeshMs > 60) {
    renderer.rebuild(currentCut());
    world._dirty = false;
    lastMeshMs = now;
  }
  if (steps > 0) { updateStats(); renderInspect(); }

  renderer.updateColony(sim, currentCut(), sim.cfg.moveTicksPerCell);
});
