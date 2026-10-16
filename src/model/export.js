// Exports 3D : STL binaire (un fichier par tuile, zippés s'il y en a plusieurs),
// 3MF (un objet par tuile), GLB (aperçu couleur, unités en mètres, Y vers le haut).
import { zipSync, strToU8 } from 'fflate';
import { paintCode } from './colors.js';

export function stlBinary({ positions, indices }, name = 'relief') {
  const n = indices.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const header = `relief-studio ${name}`.slice(0, 79);
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i) & 127);
  dv.setUint32(80, n, true);
  let o = 84;
  const P = positions;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
    o += 12;
    for (const v of [a, b, c]) {
      dv.setFloat32(o, P[v], true); dv.setFloat32(o + 4, P[v + 1], true); dv.setFloat32(o + 8, P[v + 2], true);
      o += 12;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}

export function stlFiles(model, base) {
  if (model.parts.length === 1) return { name: `${base}.stl`, data: stlBinary(model.parts[0], base), type: 'model/stl' };
  const files = {};
  for (const p of model.parts) files[`${base}-${p.name}.stl`] = stlBinary(p, `${base} ${p.name}`);
  return { name: `${base}-tuiles.zip`, data: zipSync(files, { level: 6 }), type: 'application/zip' };
}

// paint (facultatif) : { filaments: [hex…], filamentOf(code) } → chaque triangle du dessus
// porte sa couleur (matériau 3MF standard) et sa peinture pour PrusaSlicer
// (slic3rpe:mmu_segmentation) et Bambu Studio / OrcaSlicer (paint_color).
// Le filament 1 (socle) reste celui des flancs et du dessous.
export function threeMF(model, base, paint = null) {
  const objects = [];
  const items = [];
  const matId = model.parts.length + 1;
  const resources = paint
    ? `<basematerials id="${matId}">${paint.filaments.map((hex, f) => `<base name="Filament ${f + 1}" displaycolor="${hex.toUpperCase()}FF"/>`).join('')}</basematerials>`
    : '';
  model.parts.forEach((p, k) => {
    const P = p.positions, I = p.indices;
    const vs = new Array(P.length / 3);
    for (let v = 0; v < vs.length; v++) vs[v] = `<vertex x="${P[3 * v].toFixed(3)}" y="${P[3 * v + 1].toFixed(3)}" z="${P[3 * v + 2].toFixed(3)}"/>`;
    const ts = new Array(I.length / 3);
    for (let t = 0; t < ts.length; t++) {
      let extra = '';
      if (paint && t < p.topCount) {
        const f = paint.filamentOf(p.triCodes[t]);
        if (f > 1) {
          const code = paintCode(f);
          extra = ` p1="${f - 1}" slic3rpe:mmu_segmentation="${code}" paint_color="${code}"`;
        }
      }
      ts[t] = `<triangle v1="${I[3 * t]}" v2="${I[3 * t + 1]}" v3="${I[3 * t + 2]}"${extra}/>`;
    }
    const id = k + 1;
    const label = p.name ? `${base} ${p.name}` : base;
    const mat = paint ? ` pid="${matId}" pindex="0"` : '';
    objects.push(`<object id="${id}" name="${label}" type="model"${mat}><mesh><vertices>${vs.join('')}</vertices><triangles>${ts.join('')}</triangles></mesh></object>`);
    // Tuiles légèrement écartées pour être séparées dans le trancheur.
    const gap = 6;
    items.push(`<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${p.tile[0] * gap} ${-p.tile[1] * gap} 0"/>`);
  });
  const modelXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xml:lang="fr-FR" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">` +
    `<metadata name="Application">Relief Studio</metadata>` +
    (paint ? `<metadata name="slic3rpe:MmPaintingVersion">1</metadata>` : '') +
    `<resources>${resources}${objects.join('')}</resources><build>${items.join('')}</build></model>`;
  const files = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
    ),
    '3D/3dmodel.model': strToU8(modelXml),
  };
  return { name: `${base}.3mf`, data: zipSync(files, { level: 6 }), type: 'model/3mf' };
}

export async function glb(meshObject, base) {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const root = meshObject.clone();
  root.rotation.x = -Math.PI / 2; // Z-up (impression) → Y-up (glTF)
  root.scale.setScalar(0.001); // mm → m
  root.updateMatrixWorld(true);
  const data = await new GLTFExporter().parseAsync(root, { binary: true });
  return { name: `${base}.glb`, data: new Uint8Array(data), type: 'model/gltf-binary' };
}
