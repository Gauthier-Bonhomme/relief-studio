// Export « projet Bambu Studio » : Bambu Studio n'importe la liste des filaments que depuis un
// 3MF qui se présente comme un projet Bambu, avec ses réglages de projet COMPLETS (un profil
// partiel le fait planter). On repart donc d'un projet enregistré par l'utilisateur dans Bambu
// Studio (son imprimante, ses réglages) et on n'y change que les filaments.
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { paintCode } from './colors.js';

const SETTINGS = 'Metadata/project_settings.config';

// Réglages « par filament » qui ne commencent pas par filament_ : noms des réglages des
// profils de filaments de Bambu Studio. Certaines listes ont la même longueur par hasard
// (machine_max_* : modes normal et silencieux) et ne doivent surtout pas être touchées.
const PER_FILAMENT_EXTRA = new Set([
  'activate_air_filtration', 'additional_cooling_fan_speed', 'chamber_temperatures',
  'circle_compensation_speed', 'close_fan_the_first_x_layers', 'complete_print_exhaust_fan_speed',
  'cool_plate_temp', 'cool_plate_temp_initial_layer', 'cooling_perimeter_transition_distance',
  'cooling_slowdown_logic', 'counter_coef_1', 'counter_coef_2', 'counter_coef_3', 'counter_limit_max',
  'counter_limit_min', 'diameter_limit', 'during_print_exhaust_fan_speed', 'enable_overhang_bridge_fan',
  'enable_pressure_advance', 'eng_plate_temp', 'eng_plate_temp_initial_layer', 'fan_cooling_layer_time',
  'fan_max_speed', 'fan_min_speed', 'first_x_layer_fan_speed', 'full_fan_speed_layer', 'hole_coef_1',
  'hole_coef_2', 'hole_coef_3', 'hole_limit_max', 'hole_limit_min', 'hot_plate_temp',
  'hot_plate_temp_initial_layer', 'impact_strength_z', 'long_retractions_when_ec',
  'no_slow_down_for_cooling_on_outwalls', 'nozzle_temperature', 'nozzle_temperature_initial_layer',
  'nozzle_temperature_range_high', 'nozzle_temperature_range_low', 'overhang_fan_speed',
  'overhang_fan_threshold', 'override_process_overhang_speed', 'pre_start_fan_time', 'pressure_advance',
  'reduce_fan_stop_start_freq', 'required_nozzle_HRC', 'retraction_distances_when_ec',
  'slow_down_for_layer_cooling', 'slow_down_layer_time', 'slow_down_min_speed', 'supertack_plate_temp',
  'supertack_plate_temp_initial_layer', 'temperature_vitrification', 'textured_plate_temp',
  'textured_plate_temp_initial_layer', 'volumetric_speed_coefficients', 'default_filament_colour',
]);
// Listes [réglage d'impression, un par filament…, imprimante] : longueur = filaments + 2.
const PRESET_GROUPS = ['inherits_group', 'different_settings_to_system'];
const isPerFilament = (k) => k.startsWith('filament') || PER_FILAMENT_EXTRA.has(k);

// Lit le profil d'un projet Bambu Studio (.3mf) : renvoie { cfg, summary } ou lève une erreur.
export function readBambuProfile(bytes, fileName = '') {
  const files = unzipSync(bytes, { filter: (f) => f.name === SETTINGS });
  if (!files[SETTINGS]) throw new Error('bambu-no-settings');
  const cfg = JSON.parse(strFromU8(files[SETTINGS]));
  if (!Array.isArray(cfg.filament_colour) || !cfg.filament_colour.length || !cfg.printer_settings_id)
    throw new Error('bambu-invalid-settings');
  return {
    cfg,
    summary: { file: fileName, printer: cfg.printer_settings_id, print: cfg.print_settings_id || '', version: cfg.version || '' },
  };
}

// Copie du profil avec n filaments : chaque réglage par filament est fait de blocs (une ou
// plusieurs variantes par filament) ; on duplique le bloc du premier filament. La matrice de
// purge (n × n par extrudeur) est reconstruite avec la plus forte valeur d'origine.
export function withFilaments(cfg0, colors) {
  const cfg = structuredClone(cfg0);
  const m = cfg.filament_colour.length;
  const n = colors.length;
  for (const [k, v] of Object.entries(cfg)) {
    if (!Array.isArray(v) || !isPerFilament(k) || k === 'flush_volumes_matrix') continue;
    if (v.length % m) continue;
    const stride = v.length / m;
    const block = v.slice(0, stride);
    cfg[k] = Array.from({ length: n }, () => block).flat();
  }
  if (Array.isArray(cfg.flush_volumes_matrix) && cfg.flush_volumes_matrix.length % (m * m) === 0) {
    const ext = cfg.flush_volumes_matrix.length / (m * m);
    const purge = String(Math.max(...cfg.flush_volumes_matrix.map(Number).filter(Number.isFinite), 280));
    const mat = [];
    for (let e = 0; e < ext; e++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) mat.push(i === j ? '0' : purge);
    cfg.flush_volumes_matrix = mat;
  }
  if (Array.isArray(cfg.flush_volumes_vector) && cfg.flush_volumes_vector.length % m === 0) {
    const stride = cfg.flush_volumes_vector.length / m;
    cfg.flush_volumes_vector = Array.from({ length: n * stride }, (_, i) => cfg.flush_volumes_vector[i % stride]);
  }
  for (const k of PRESET_GROUPS) {
    const v = cfg[k];
    if (Array.isArray(v) && v.length === m + 2) cfg[k] = [v[0], ...Array(n).fill(v[1]), v[m + 1]];
  }
  const hex = colors.map((c) => c.toUpperCase());
  cfg.filament_colour = hex;
  if (Array.isArray(cfg.filament_multi_colour)) cfg.filament_multi_colour = hex;
  if (Array.isArray(cfg.default_filament_colour)) cfg.default_filament_colour = Array(n).fill('');
  if (Array.isArray(cfg.filament_self_index)) cfg.filament_self_index = Array.from({ length: n }, (_, i) => String(i + 1));
  return cfg;
}

// Centre du plateau d'après printable_area ["0x0", "256x0", …].
function bedCenter(cfg) {
  const pts = (cfg.printable_area || []).map((s) => String(s).split('x').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
  if (!pts.length) return [128, 128];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// model : sortie de buildModel ; paint : { filaments, filamentOf } ; profile : cfg Bambu.
export function bambuProject(model, base, paint, profile) {
  const cfg = withFilaments(profile, paint.filaments);
  const [bx, by] = bedCenter(cfg);
  const dx = bx - model.center[0], dy = by - model.center[1];
  const objects = [], items = [], settings = [];
  model.parts.forEach((p, k) => {
    const P = p.positions, I = p.indices;
    const vs = new Array(P.length / 3);
    for (let v = 0; v < vs.length; v++) vs[v] = `<vertex x="${P[3 * v].toFixed(3)}" y="${P[3 * v + 1].toFixed(3)}" z="${P[3 * v + 2].toFixed(3)}"/>`;
    const ts = new Array(I.length / 3);
    for (let t = 0; t < ts.length; t++) {
      const f = t < p.topCount ? paint.filamentOf(p.triCodes[t]) : 1;
      ts[t] = `<triangle v1="${I[3 * t]}" v2="${I[3 * t + 1]}" v3="${I[3 * t + 2]}"${f > 1 ? ` paint_color="${paintCode(f)}"` : ''}/>`;
    }
    const id = k + 1;
    const label = esc(p.name ? `${base} ${p.name}` : base);
    objects.push(`<object id="${id}" name="${label}" type="model"><mesh><vertices>${vs.join('')}</vertices><triangles>${ts.join('')}</triangles></mesh></object>`);
    items.push(`<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${dx.toFixed(3)} ${dy.toFixed(3)} 0" printable="1"/>`);
    settings.push(
      `<object id="${id}"><metadata key="name" value="${label}"/><metadata key="extruder" value="1"/>` +
        `<part id="1" subtype="normal_part"><metadata key="name" value="${label}"/></part></object>`,
    );
  });
  const today = new Date().toISOString().slice(0, 10);
  const modelXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xml:lang="fr-FR" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">` +
    `<metadata name="Application">BambuStudio-${esc(cfg.version || '01.09.00.00')}</metadata>` +
    `<metadata name="BambuStudio:3mfVersion">1</metadata>` +
    `<metadata name="CreationDate">${today}</metadata><metadata name="Title">${esc(base)}</metadata>` +
    `<resources>${objects.join('')}</resources><build>${items.join('')}</build></model>`;
  const plate =
    `<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value=""/><metadata key="locked" value="false"/>` +
    model.parts.map((_, k) => `<model_instance><metadata key="object_id" value="${k + 1}"/><metadata key="instance_id" value="0"/></model_instance>`).join('') +
    `</plate>`;
  const files = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
        `<Default Extension="config" ContentType="text/xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
    ),
    '3D/3dmodel.model': strToU8(modelXml),
    [SETTINGS]: strToU8(JSON.stringify(cfg, null, 4)),
    'Metadata/model_settings.config': strToU8(`<?xml version="1.0" encoding="UTF-8"?><config>${settings.join('')}${plate}</config>`),
  };
  return { name: `${base}-bambu.3mf`, data: zipSync(files, { level: 6 }), type: 'model/3mf' };
}
