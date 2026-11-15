// نموذج وهمي مصغّر لـ three يكفي لتشغيل منطق اللعبة دون متصفح
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } setScalar(s) { return this.set(s, s, s); } copy(v) { return this.set(v.x, v.y, v.z); } }
class Col { constructor(v) { this.v = v; } set(v) { this.v = v; return this; } setHex(v) { this.v = v; return this; } lerp() { return this; } copy(c) { this.v = c.v; return this; } }
class Obj {
  constructor() { this.position = new V3(); this.rotation = new V3(); this.scale = new V3(1, 1, 1); this.children = []; this.visible = true; this.userData = {}; this.name = ''; this.matrix = {}; this.castShadow = false; this.receiveShadow = false; this.parent = null; }
  add(o) { this.children.push(o); o.parent = this; return this; }
  remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); return this; }
  getObjectByName(n) { return this.children.find((c) => c.name === n); }
  clone() { const o = new this.constructor(this.geometry, this.material); o.position = new V3(this.position.x, this.position.y, this.position.z); return o; }
  updateMatrix() {} updateMatrixWorld() {} lookAt() {}
}
class Mat { constructor(o = {}) { this.color = new Col(o.color); this.emissive = new Col(o.emissive || 0); this.opacity = o.opacity === undefined ? 1 : o.opacity; this.emissiveIntensity = o.emissiveIntensity === undefined ? 1 : o.emissiveIntensity; } }
class Geo { rotateX() { return this; } }
class Tex { constructor() { this.repeat = new V3(); } }
export const SRGBColorSpace = 's', RepeatWrapping = 'r', DoubleSide = 2, PCFSoftShadowMap = 1;
export class Object3D extends Obj {}
export class Group extends Obj {}
export class Mesh extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = m; } }
export class Sprite extends Obj { constructor(m) { super(); this.material = m; } }
export class InstancedMesh extends Mesh { constructor(g, m, n) { super(g, m); this.count = n; this.instanceMatrix = {}; } setMatrixAt() {} }
export class Scene extends Obj { constructor() { super(); this.background = new Col(); this.fog = null; } }
export class Fog { constructor(c) { this.color = new Col(c); } }
export class Color extends Col {}
export class Vector3 extends V3 {}
export class PerspectiveCamera extends Obj { constructor(fov) { super(); this.fov = fov; this.aspect = 1; } updateProjectionMatrix() {} }
export class HemisphereLight extends Obj { constructor() { super(); this.intensity = 1; } }
export class DirectionalLight extends Obj { constructor() { super(); this.intensity = 1; this.target = new Obj(); this.shadow = { mapSize: new V3(), bias: 0, camera: {} }; } }
export class WebGLRenderer { constructor() { this.shadowMap = {}; } setPixelRatio() {} setSize() {} render() { this.renders = (this.renders || 0) + 1; } }
export class CanvasTexture extends Tex {}
export class MeshLambertMaterial extends Mat {} export class MeshBasicMaterial extends Mat {} export class SpriteMaterial extends Mat {}
export class BoxGeometry extends Geo {} export class PlaneGeometry extends Geo {} export class CylinderGeometry extends Geo {} export class SphereGeometry extends Geo {}
export class IcosahedronGeometry extends Geo {} export class RingGeometry extends Geo {} export class ConeGeometry extends Geo {}
