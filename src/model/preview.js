// Aperçu 3D (three.js), rendu à la demande : pas de boucle d'animation permanente.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeRamp, hexToRgb } from '../poster/palettes.js';

export class ModelPreview {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
    this.camera.up.set(0, 0, 1);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-1, 1.2, 1.4);
    this.scene.add(sun);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.render());
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  setBackground(hex) {
    this.scene.background = new THREE.Color(hex);
    this.render();
  }

  // model : sortie de buildModel ; colors : { ramp, accent, side }
  setModel(model, colors, keepView = false) {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      c.traverse((o) => o.geometry?.dispose());
    }
    const ramp = makeRamp(colors.ramp);
    const side = hexToRgb(colors.side).map((v) => v / 255);
    const { info } = model;
    const zTop = info.heightMm, zBase = Math.max(0.01, zTop - info.reliefMm - (info.trackMm || 0));
    const exploded = model.parts.length > 1 ? 4 : 0;
    for (const p of model.parts) {
      const nTop = p.topCount * 3;
      // Dessus : sommets partagés → ombrage lissé.
      const top = new THREE.BufferGeometry();
      top.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      top.setIndex(new THREE.BufferAttribute(p.indices.subarray(0, nTop), 1));
      const col = new Float32Array(p.positions.length);
      for (let v = 0; v < p.positions.length / 3; v++) {
        const zz = p.positions[3 * v + 2];
        const c = ramp(((zz - zBase) / Math.max(0.1, zTop - zBase)) * 0.92 + 0.04).map((x) => x / 255);
        col.set(c, 3 * v);
      }
      top.setAttribute('color', new THREE.BufferAttribute(col, 3));
      top.computeVertexNormals();
      // Flancs et dessous : facettes nettes.
      const rest = new THREE.BufferGeometry();
      rest.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      rest.setIndex(new THREE.BufferAttribute(p.indices.subarray(nTop), 1));
      const restFlat = rest.toNonIndexed();
      restFlat.computeVertexNormals();
      const g = new THREE.Group();
      g.add(new THREE.Mesh(top, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 })));
      g.add(new THREE.Mesh(restFlat, new THREE.MeshStandardMaterial({ color: new THREE.Color(...side), roughness: 0.95 })));
      g.position.set(p.tile[0] * exploded - model.center[0], -p.tile[1] * exploded - model.center[1], 0);
      g.name = p.name || 'relief';
      this.group.add(g);
    }
    if (!keepView || !this.framed) {
      const span = Math.max(info.widthMm, info.depthMm);
      this.camera.position.set(0, -span * 1.75, span * 1.35);
      this.controls.target.set(0, 0, info.heightMm * 0.3);
      this.camera.near = span / 100;
      this.camera.far = span * 20;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.framed = true;
    }
    this.render();
  }

  // Maillage unique coloré, pour l'export GLB.
  exportObject() {
    return this.group;
  }

  snapshot() {
    this.render();
    return this.renderer.domElement.toDataURL('image/png');
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.ro.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
