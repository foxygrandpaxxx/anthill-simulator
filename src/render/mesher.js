import * as THREE from "three";
import { Material, MATERIAL_COLOR } from "../world/materials.js";

// Cube face table. Each face lists its outward normal and 4 corner offsets
// in counter-clockwise order (as seen from outside), so front-face winding
// is correct. Indices per quad: [0,1,2, 0,2,3].
const FACES = [
  { dir: [1, 0, 0], corners: [[1, 0, 1], [1, 1, 1], [1, 1, 0], [1, 0, 0]] }, // +X
  { dir: [-1, 0, 0], corners: [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]] }, // -X
  { dir: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] }, // +Y (top)
  { dir: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] }, // -Y
  { dir: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] }, // +Z
  { dir: [0, 0, -1], corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] }, // -Z
];

// Deterministic per-voxel jitter so the soil reads as textured, not flat.
function jitter(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h >>> 8) / 16777216; // 0..1
}

const AXIS_INDEX = { x: 0, y: 1, z: 2 };

/**
 * Build a single BufferGeometry for the world using face-culled meshing.
 *
 * The cutaway is voxel-native: any voxel whose coordinate along `cut.axis`
 * exceeds `cut.value` is treated as empty. This both removes it from the mesh
 * and exposes the faces of the voxels behind it, producing a solid-looking
 * blocky cross-section (no hollow-shell artifacts).
 */
export function buildMesh(world, cut = null) {
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  let vcount = 0;

  const cutAxis = cut ? AXIS_INDEX[cut.axis] : -1;
  const cutValue = cut ? cut.value : Infinity;

  const removedByCut = (x, y, z) => {
    if (cutAxis < 0) return false;
    const c = cutAxis === 0 ? x : cutAxis === 1 ? y : z;
    return c > cutValue;
  };

  // Empty for meshing purposes: out of bounds, AIR, or cut away.
  const isEmpty = (x, y, z) => {
    if (!world.inBounds(x, y, z)) return true;
    if (removedByCut(x, y, z)) return true;
    return world.voxels[world.idx(x, y, z)] === Material.AIR;
  };

  const { sx, sy, sz } = world;
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        const m = world.voxels[world.idx(x, y, z)];
        if (m === Material.AIR) continue;
        if (removedByCut(x, y, z)) continue;

        const base = MATERIAL_COLOR[m] || [1, 0, 1];
        const j = 0.82 + jitter(x, y, z) * 0.32; // brightness wobble
        const r = base[0] * j;
        const g = base[1] * j;
        const b = base[2] * j;

        for (let f = 0; f < 6; f++) {
          const { dir, corners } = FACES[f];
          if (!isEmpty(x + dir[0], y + dir[1], z + dir[2])) continue;

          for (let c = 0; c < 4; c++) {
            const cc = corners[c];
            positions.push(x + cc[0], y + cc[1], z + cc[2]);
            normals.push(dir[0], dir[1], dir[2]);
            colors.push(r, g, b);
          }
          indices.push(
            vcount, vcount + 1, vcount + 2,
            vcount, vcount + 2, vcount + 3,
          );
          vcount += 4;
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  return { geometry: geo, triangles: indices.length / 3 };
}
