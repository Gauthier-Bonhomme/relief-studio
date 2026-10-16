// Aperçu 3D (three.js), rendu à la demande : pas de boucle d'animation permanente.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { hexToRgb } from '../poster/palettes.js';

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
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b2a6, 1.9));
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

  // model : sortie de buildModel ; colors : { colorOf(code) → hex, base: hex (flancs et dessous) }
  setModel(model, colors, keepView = false) {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      c.traverse((o) => o.geometry?.dispose());
    }
    const side = hexToRgb(colors.base).map((v) => v / 255);
    const rgbOf = new Map();
    const codeRgb = (code) => {
      if (!rgbOf.has(code)) rgbOf.set(code, hexToRgb(colors.colorOf(code)).map((v) => v / 255));
      return rgbOf.get(code);
    };
    const { info } = model;
    const exploded = model.parts.length > 1 ? 4 : 0;
    for (const p of model.parts) {
      const nTop = p.topCount * 3;
      // Dessus : normales lissées sur les sommets partagés, puis une couleur par triangle
      // (comme la peinture du trancheur).
      const indexed = new THREE.BufferGeometry();
      indexed.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      indexed.setIndex(new THREE.BufferAttribute(p.indices.subarray(0, nTop), 1));
      indexed.computeVertexNormals();
      const top = indexed.toNonIndexed();
      indexed.dispose();
      const col = new Float32Array(nTop * 3);
      for (let t = 0; t < p.topCount; t++) {
        const c = codeRgb(p.triCodes[t]);
        col.set(c, 9 * t);
        col.set(c, 9 * t + 3);
        col.set(c, 9 * t + 6);
      }
      top.setAttribute('color', new THREE.BufferAttribute(col, 3));
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
