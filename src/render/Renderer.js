import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildMesh } from "./mesher.js";

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

    const antMat = new THREE.MeshStandardMaterial({ color: 0x241310, roughness: 0.5, metalness: 0.1 });
    this.antMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.85, 0.65, 1.3), antMat, maxAnts);
    this.antMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.antMesh.frustumCulled = false;
    this.worldGroup.add(this.antMesh);

    // Carried load — per-instance color (brown dirt vs gold food).
    const loadMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    this.loadMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), loadMat, maxAnts);
    this.loadMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.loadMesh.frustumCulled = false;
    this.worldGroup.add(this.loadMesh);

    // Brood — per-instance color/scale by stage.
    const broodMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
    this.broodMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), broodMat, maxBrood);
    this.broodMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.broodMesh.frustumCulled = false;
    this.worldGroup.add(this.broodMesh);

    // Queen — a single larger reddish body.
    const queenMat = new THREE.MeshStandardMaterial({ color: 0x6b1f1f, roughness: 0.5, metalness: 0.15 });
    this.queenMesh = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.8, 1.7), queenMat);
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

        d.position.set(x, y, z);
        d.scale.setScalar(hidden ? 0 : 1);
        d.rotation.set(0, 0, 0);
        d.updateMatrix();
        this.antMesh.setMatrixAt(i, d.matrix);

        d.position.set(x, y + 0.55, z);
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

    // Brood.
    const brood = sim.brood;
    const STAGE = {
      egg: { s: 0.28, hex: 0xeae6d8 },
      larva: { s: 0.42, hex: 0xf0e2b0 },
      pupa: { s: 0.52, hex: 0xcdb98a },
    };
    for (let i = 0; i < this.maxBrood; i++) {
      if (i < brood.length) {
        const b = brood[i];
        const st = STAGE[b.stage];
        const hidden = removed(b.x, b.y, b.z);
        d.position.set(b.x + 0.5, b.y + 0.35, b.z + 0.5);
        d.scale.setScalar(hidden ? 0 : st.s);
        d.rotation.set(0, 0, 0);
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

    // Queen.
    if (sim.queen) {
      const q = sim.queen;
      const hidden = removed(q.x, q.y, q.z);
      this.queenMesh.visible = !hidden;
      this.queenMesh.position.set(q.x + 0.5, q.y + 0.4, q.z + 0.5);
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
