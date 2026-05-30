import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { buildMesh } from "./mesher.js";

// --- Procedural insect geometry (built from boxes, merged) -----------------
// All models face +X (forward), so an instance's heading is a rotation about Y.
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);
const _pos = new THREE.Vector3();

function part(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _pos.set(x, y, z);
  _m4.compose(_pos, _q, _one);
  g.applyMatrix4(_m4);
  return g;
}

// A worker ant: gaster, petiole, thorax, head, mandibles, antennae, 6 legs.
function makeAntGeometry() {
  const p = [
    part(0.60, 0.46, 0.46, -0.45, 0.00, 0),   // gaster (abdomen)
    part(0.16, 0.14, 0.14, -0.10, 0.01, 0),   // petiole (waist)
    part(0.42, 0.38, 0.42, 0.18, 0.03, 0),    // thorax
    part(0.34, 0.36, 0.44, 0.52, 0.05, 0),    // head
    part(0.18, 0.07, 0.07, 0.74, 0.00, 0.10, 0, -0.5, 0), // mandible R
    part(0.18, 0.07, 0.07, 0.74, 0.00, -0.10, 0, 0.5, 0), // mandible L
    part(0.34, 0.05, 0.05, 0.80, 0.22, 0.12, 0, 0.6, 0.35), // antenna R
    part(0.34, 0.05, 0.05, 0.80, 0.22, -0.12, 0, -0.6, 0.35), // antenna L
  ];
  // 3 leg-bars through the body read as 6 legs and can't look broken from any angle.
  for (const lx of [0.34, 0.16, -0.02]) p.push(part(0.07, 0.07, 0.62, lx, -0.10, 0));
  const g = mergeGeometries(p, false);
  p.forEach((x) => x.dispose());
  return g;
}

// The queen: same body plan, scaled up with a large egg-laden gaster.
function makeQueenGeometry() {
  const p = [
    part(1.15, 0.82, 0.82, -0.70, 0.00, 0),   // big gaster
    part(0.24, 0.22, 0.22, -0.05, 0.02, 0),   // petiole
    part(0.58, 0.52, 0.58, 0.38, 0.06, 0),    // thorax
    part(0.46, 0.48, 0.58, 0.82, 0.10, 0),    // head
    part(0.42, 0.07, 0.07, 1.10, 0.32, 0.18, 0, 0.6, 0.35),
    part(0.42, 0.07, 0.07, 1.10, 0.32, -0.18, 0, -0.6, 0.35),
  ];
  for (const lx of [0.50, 0.28, 0.06]) p.push(part(0.10, 0.10, 1.0, lx, -0.14, 0));
  const g = mergeGeometries(p, false);
  p.forEach((x) => x.dispose());
  return g;
}

// Owns the Three.js scene, camera, lights and the world mesh.
// Read-only with respect to the world model.
export class Renderer {
  constructor(container) {
    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0c0a09);
    this.scene.fog = new THREE.Fog(0x0c0a09, 120, 320);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      55,
      container.clientWidth / container.clientHeight,
      0.1,
      1000,
    );

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    // Lighting: a soft sky/ground hemisphere plus a key directional sun.
    const hemi = new THREE.HemisphereLight(0xbcd2ff, 0x4a3826, 0.85);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.1);
    sun.position.set(0.6, 1, 0.4);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.25);
    fill.position.set(-0.5, 0.3, -0.6);
    this.scene.add(fill);

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.0,
      side: THREE.DoubleSide, // so cutaway cross-sections are always visible
    });

    this.mesh = null;
    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);

    // Colony rendering: instanced ants + carried load, instanced brood, queen.
    this._dummy = new THREE.Object3D();
    this._color = new THREE.Color();
    this.antMesh = null;
    this.loadMesh = null;
    this.broodMesh = null;
    this.queenMesh = null;
    this.maxAnts = 0;
    this.maxBrood = 0;

    // X-ray view: soil goes mostly transparent so the whole nest is visible.
    this._xray = false;
    this.xrayOpacity = 0.2;

    // Picking (click-to-inspect, drop-food).
    this._ray = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();

    window.addEventListener("resize", () => this.onResize());
    // The preview/browser may give the container a non-zero size only after
    // first paint; observe it so the canvas always matches (fixes the canvas
    // stuck at 0x0 when the page loads at a zero viewport size).
    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => this.onResize());
      this._resizeObserver.observe(container);
    }
    this.onResize();
  }

  initColony(maxAnts, maxBrood) {
    // Dispose any previous colony meshes.
    for (const m of [this.antMesh, this.loadMesh, this.broodMesh, this.queenMesh]) {
      if (m) { this.worldGroup.remove(m); m.geometry.dispose(); }
    }
    this.maxAnts = maxAnts;
    this.maxBrood = maxBrood;

    const antMat = new THREE.MeshStandardMaterial({ color: 0x2a1812, roughness: 0.45, metalness: 0.15 });
    this.antMesh = new THREE.InstancedMesh(makeAntGeometry(), antMat, maxAnts);
    this.antMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.antMesh.frustumCulled = false;
    this.worldGroup.add(this.antMesh);

    // Carried load — per-instance color (brown dirt vs gold food).
    const loadMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    this.loadMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), loadMat, maxAnts);
    this.loadMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.loadMesh.frustumCulled = false;
    this.worldGroup.add(this.loadMesh);

    // Brood — rounded (sphere) with per-instance color/scale by stage.
    const broodMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    this.broodMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.5, 8, 6), broodMat, maxBrood);
    this.broodMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.broodMesh.frustumCulled = false;
    this.worldGroup.add(this.broodMesh);

    // Queen — a large, distinct reddish ant.
    const queenMat = new THREE.MeshStandardMaterial({ color: 0x6e1f1f, roughness: 0.45, metalness: 0.2 });
    this.queenMesh = new THREE.Mesh(makeQueenGeometry(), queenMat);
    this.queenMesh.visible = false;
    this.worldGroup.add(this.queenMesh);

    this._applyXray(); // re-apply current X-ray state to the fresh meshes
  }

  // Toggle X-ray: soil becomes mostly transparent and stops occluding, so the
  // entire tunnel network and its colonists are visible at once. Colonists are
  // boosted (always-draw + emissive glow) so they pop through the glassy soil.
  setXray(on) {
    this._xray = on;
    this._applyXray();
  }

  _applyXray() {
    const on = this._xray;
    const m = this.material;
    m.transparent = on;
    m.opacity = on ? this.xrayOpacity : 1;
    m.depthWrite = !on; // don't occlude the colonists when see-through
    // A warm self-illumination so the translucent soil reads as glowing glass
    // rather than going murky-dark over the near-black background.
    m.emissive.setHex(on ? 0x3a2a18 : 0x000000);
    m.needsUpdate = true;

    const glow = (mesh, hex) => {
      if (!mesh) return;
      mesh.material.depthTest = !on; // colonists always draw over the glassy soil
      mesh.renderOrder = on ? 10 : 0;
      if (mesh.material.emissive) {
        mesh.material.emissive.setHex(on ? hex : 0x000000);
        mesh.material.needsUpdate = true;
      }
    };
    glow(this.antMesh, 0x553219);
    glow(this.loadMesh, 0x000000);
    glow(this.broodMesh, 0x4a4530);
    glow(this.queenMesh, 0x7a1c1c);
  }

  _cutTest(cut) {
    const axis = cut ? cut.axis : null;
    const cutValue = cut ? cut.value : Infinity;
    return (x, y, z) => {
      if (!axis) return false;
      const c = axis === "x" ? x : axis === "y" ? y : z;
      return c > cutValue;
    };
  }

  updateColony(sim, cut, moveTicks) {
    if (!this.antMesh) return;
    const removed = this._cutTest(cut);
    const d = this._dummy;
    const col = this._color;
    const now = performance.now() * 0.001;

    // Ants + carried loads.
    const ants = sim.ants;
    for (let i = 0; i < this.maxAnts; i++) {
      if (i < ants.length) {
        const a = ants[i];
        const t = Math.min(1, a.moveCounter / moveTicks);
        const x = a.px + (a.x - a.px) * t + 0.5;
        const y = a.py + (a.y - a.py) * t + 0.5;
        const z = a.pz + (a.z - a.pz) * t + 0.5;
        const hidden = removed(a.x, a.y, a.z);

        // Face the direction of travel; keep the last heading when stationary.
        if (a.x !== a.px || a.z !== a.pz) a._heading = Math.atan2(-(a.z - a.pz), a.x - a.px);
        const heading = a._heading || 0;
        // Scuttle: a quick bob + slight yaw waggle while the ant is active.
        const active = a.x !== a.px || a.z !== a.pz || a.moveCounter > 0 || a.actionTimer > 0;
        const ph = now * 9 + a.id * 1.7;
        const bob = active ? Math.abs(Math.sin(ph)) * 0.1 : 0;
        const waggle = active ? Math.sin(ph * 0.5) * 0.12 : 0;

        d.position.set(x, y + bob, z);
        d.rotation.set(0, heading + waggle, 0);
        d.scale.setScalar(hidden ? 0 : 1);
        d.updateMatrix();
        this.antMesh.setMatrixAt(i, d.matrix);

        d.position.set(x, y + 0.4, z);
        d.rotation.set(0, 0, 0);
        d.scale.setScalar(a.carrying && !hidden ? 1 : 0);
        d.updateMatrix();
        this.loadMesh.setMatrixAt(i, d.matrix);
        col.setHex(a.carrying === "food" ? 0xe0b020 : 0x4d3320);
        this.loadMesh.setColorAt(i, col);
      } else {
        d.scale.setScalar(0); d.updateMatrix();
        this.antMesh.setMatrixAt(i, d.matrix);
        this.loadMesh.setMatrixAt(i, d.matrix);
      }
    }
    this.antMesh.instanceMatrix.needsUpdate = true;
    this.loadMesh.instanceMatrix.needsUpdate = true;
    if (this.loadMesh.instanceColor) this.loadMesh.instanceColor.needsUpdate = true;

    // Brood — eggs are small & round, larvae elongated grubs, pupae fat cocoons.
    const brood = sim.brood;
    const STAGE = {
      egg: { sx: 0.30, sy: 0.30, sz: 0.30, hex: 0xeae6d8 },
      larva: { sx: 0.62, sy: 0.34, sz: 0.34, hex: 0xf0e2b0 },
      pupa: { sx: 0.54, sy: 0.42, sz: 0.42, hex: 0xcdb98a },
    };
    for (let i = 0; i < this.maxBrood; i++) {
      if (i < brood.length) {
        const b = brood[i];
        const st = STAGE[b.stage];
        const hidden = removed(b.x, b.y, b.z);
        d.position.set(b.x + 0.5, b.y + 0.3, b.z + 0.5);
        if (hidden) d.scale.setScalar(0);
        else d.scale.set(st.sx, st.sy, st.sz);
        d.rotation.set(0, (b.idx % 6) * 1.04, 0); // a little orientation variety
        d.updateMatrix();
        this.broodMesh.setMatrixAt(i, d.matrix);
        col.setHex(st.hex);
        this.broodMesh.setColorAt(i, col);
      } else {
        d.scale.setScalar(0); d.updateMatrix();
        this.broodMesh.setMatrixAt(i, d.matrix);
      }
    }
    this.broodMesh.instanceMatrix.needsUpdate = true;
    if (this.broodMesh.instanceColor) this.broodMesh.instanceColor.needsUpdate = true;

    // Queen — stationary, with a slow breathing motion.
    if (sim.queen) {
      const q = sim.queen;
      const hidden = removed(q.x, q.y, q.z);
      this.queenMesh.visible = !hidden;
      const breathe = Math.sin(now * 2) * 0.025;
      this.queenMesh.position.set(q.x + 0.5, q.y + 0.2 + breathe, q.z + 0.5);
      if (q._heading == null) q._heading = Math.PI * 0.2;
      this.queenMesh.rotation.y = q._heading;
    } else {
      this.queenMesh.visible = false;
    }
  }

  // Center the world block at the origin and frame it with the camera.
  frameWorld(world) {
    const { sx, sy, sz } = world;
    this.worldGroup.position.set(-sx / 2, -sy / 2, -sz / 2);
    const radius = Math.max(sx, sy, sz);
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(radius * 0.9, radius * 0.55, radius * 1.1);
    this.controls.update();
  }

  setWorld(world, cut) {
    this.world = world;
    this.rebuild(cut);
  }

  rebuild(cut) {
    if (this.mesh) {
      this.worldGroup.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    const { geometry, triangles } = buildMesh(this.world, cut);
    this.lastTriangles = triangles;
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.worldGroup.add(this.mesh);
  }

  onResize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    if (w === 0 || h === 0) return; // not laid out yet; ResizeObserver will retry
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _setPointer(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this._ray.setFromCamera(this._pointer, this.camera);
  }

  // Pick an ant or the queen under the cursor. Ants are small targets, so we
  // sample a small cluster of points around the cursor and take the nearest
  // hit. Returns {kind:'ant', id} | {kind:'queen'} | null.
  pickColonist(clientX, clientY) {
    const targets = [this.antMesh, this.queenMesh].filter(Boolean);
    if (!targets.length) return null;
    const offsets = [
      [0, 0], [5, 0], [-5, 0], [0, 5], [0, -5],
      [9, 9], [-9, 9], [9, -9], [-9, -9],
      [11, 0], [-11, 0], [0, 11], [0, -11],
    ];
    let best = null;
    for (const [ox, oy] of offsets) {
      this._setPointer(clientX + ox, clientY + oy);
      const hits = this._ray.intersectObjects(targets, false);
      if (hits.length && (!best || hits[0].distance < best.distance)) best = hits[0];
    }
    if (!best) return null;
    if (best.object === this.queenMesh) return { kind: "queen" };
    return { kind: "ant", id: best.instanceId };
  }

  // Pick the voxel cell at the surface under the cursor (for dropping food).
  // Returns [x,y,z] in world-model coordinates, or null.
  pickSurfaceCell(clientX, clientY) {
    if (!this.mesh) return null;
    this._setPointer(clientX, clientY);
    const hits = this._ray.intersectObject(this.mesh, false);
    if (!hits.length) return null;
    const p = hits[0].point.clone().sub(this.worldGroup.position);
    const n = hits[0].face.normal;
    p.addScaledVector(n, 0.5); // step just outside the hit face
    return [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
  }

  start(onFrame) {
    const loop = () => {
      this.frameId = requestAnimationFrame(loop);
      if (onFrame) onFrame();
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }
}
