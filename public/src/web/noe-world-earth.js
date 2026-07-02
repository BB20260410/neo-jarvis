// @ts-check
// Noe live world earth, adapted from BaiLongma's hotspot-earth component.

const THREE_LOCAL = '/vendor/three/three.module.js';
const TEX = {
  earth: '/vendor/earth/earth_atmos_2048.jpg',
  normal: '/vendor/earth/earth_normal_2048.jpg',
  specular: '/vendor/earth/earth_specular_2048.jpg',
  clouds: '/vendor/earth/earth_clouds_2048.png',
  moon: '/vendor/moon/moon_albedo_gpt_20260613.png',
  space: '/vendor/space/noe_deep_space_reference_gpt_20260613.png',
  orbitNodes: '/vendor/orbit-nodes/noe_orbit_node_beacons_gpt_20260613.png',
};

const TONE_COLORS = {
  ok: 0x9ece6a,
  warn: 0xe0af68,
  bad: 0xf7768e,
  locked: 0x7aa2f7,
  idle: 0x7d8794,
};

const ORBIT_LABEL_OFFSETS = {
  boot: [0.3, -0.08],
  social: [0.32, 0.02],
  p6: [0.3, 0.02],
  runtime: [0.32, -0.02],
  mission: [0.32, 0.06],
  vitals: [0.32, 0.02],
  proof: [0.3, -0.08],
};

const ORBIT_PLANES = [
  { inclination: 0.12, node: -0.18, roll: 0.02 },
  { inclination: -0.3, node: 0.48, roll: -0.14 },
  { inclination: 0.44, node: 1.18, roll: 0.18 },
  { inclination: -0.5, node: -0.92, roll: 0.14 },
  { inclination: 0.22, node: 1.82, roll: -0.24 },
  { inclination: -0.58, node: 0.08, roll: 0.24 },
  { inclination: 0.18, node: -2.05, roll: -0.2 },
];

const ORBIT_NODE_ATLAS_CELLS = 6;
const ORBIT_NODE_MOTION_GAIN = 7.5;

const CHINA_OUTLINE = [
  [73.5, 49.2], [82.3, 49.8], [91.2, 45.8], [97.5, 42.7], [106.2, 43.9],
  [118.2, 49.1], [126.8, 49.7], [134.5, 47.0], [130.8, 42.4], [124.2, 39.4],
  [122.0, 31.2], [116.8, 23.8], [109.8, 18.3], [105.6, 21.6], [98.2, 23.4],
  [92.0, 27.9], [86.0, 29.5], [80.1, 35.2], [74.6, 39.8], [73.5, 49.2],
];

const CHINA_CITIES = [
  { lat: 39.9042, lon: 116.4074, scale: 1.25 },
  { lat: 31.2304, lon: 121.4737, scale: 1.15 },
  { lat: 22.5431, lon: 114.0579, scale: 0.95 },
  { lat: 23.1291, lon: 113.2644, scale: 0.95 },
  { lat: 30.5728, lon: 104.0668, scale: 0.9 },
  { lat: 30.5928, lon: 114.3055, scale: 0.86 },
  { lat: 34.3416, lon: 108.9398, scale: 0.82 },
];

const NIGHT_LIGHTS = [
  ...CHINA_CITIES,
  { lat: 35.6762, lon: 139.6503, scale: 0.8 },
  { lat: 37.5665, lon: 126.978, scale: 0.7 },
  { lat: 1.3521, lon: 103.8198, scale: 0.72 },
  { lat: 28.6139, lon: 77.209, scale: 0.72 },
  { lat: 55.7558, lon: 37.6173, scale: 0.68 },
  { lat: 48.8566, lon: 2.3522, scale: 0.72 },
  { lat: 51.5072, lon: -0.1276, scale: 0.75 },
  { lat: 40.7128, lon: -74.006, scale: 0.82 },
  { lat: 34.0522, lon: -118.2437, scale: 0.7 },
  { lat: -23.5505, lon: -46.6333, scale: 0.68 },
];

let THREE = null;

async function loadThree() {
  if (THREE) return THREE;
  THREE = await import(THREE_LOCAL);
  return THREE;
}

function seededNoise(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createProceduralEarthTexture(T) {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const ocean = ctx.createLinearGradient(0, 0, 0, height);
  ocean.addColorStop(0, '#061a2e');
  ocean.addColorStop(0.32, '#0a2d4e');
  ocean.addColorStop(0.52, '#0d3860');
  ocean.addColorStop(0.76, '#0a2d4e');
  ocean.addColorStop(1, '#061a2e');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, width, height);

  const toCanvas = (lon, lat) => [((lon + 180) / 360) * width, ((90 - lat) / 180) * height];
  const poly = (coords, fill) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    coords.forEach(([lon, lat], index) => {
      const [x, y] = toCanvas(lon, lat);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
  };

  const land = '#476e35';
  poly([[-170,72],[-60,72],[-55,45],[-65,25],[-85,15],[-115,20],[-130,30],[-140,55],[-165,62]], land);
  poly([[-73,76],[-20,83],[-17,76],[-30,70],[-55,68],[-66,72]], '#6f8a6d');
  poly([[-82,12],[-60,12],[-35,5],[-35,-25],[-55,-55],[-68,-55],[-75,-40],[-80,-10]], land);
  poly([[0,72],[30,72],[35,60],[30,45],[15,38],[0,38],[-10,45],[-10,60]], land);
  poly([[-18,38],[52,38],[52,10],[45,-10],[35,-35],[20,-55],[10,-35],[0,0],[-18,15]], '#5f6d32');
  poly([[30,72],[180,72],[180,40],[140,20],[120,10],[100,5],[80,12],[60,20],[40,38],[28,60]], land);
  poly([[95,25],[110,10],[105,0],[95,5],[90,15]], land);
  poly([[114,-22],[154,-22],[154,-39],[140,-38],[125,-33],[113,-28]], '#8b6d3a');
  ctx.fillStyle = 'rgba(208,232,255,0.55)';
  ctx.fillRect(0, height * 0.89, width, height * 0.11);
  ctx.fillRect(0, 0, width, height * 0.04);

  const texture = new T.CanvasTexture(canvas);
  if (T.SRGBColorSpace) texture.colorSpace = T.SRGBColorSpace;
  return texture;
}

function createMoonTexture(T) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const base = ctx.createRadialGradient(size * 0.35, size * 0.32, 12, size * 0.5, size * 0.5, size * 0.54);
  base.addColorStop(0, '#f4f0dc');
  base.addColorStop(0.48, '#bdb8a9');
  base.addColorStop(1, '#5d6270');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const random = seededNoise(0x1000aa);
  for (let i = 0; i < 34; i += 1) {
    const x = size * (0.12 + random() * 0.76);
    const y = size * (0.12 + random() * 0.76);
    const r = 4 + random() * 15;
    ctx.globalAlpha = 0.12 + random() * 0.18;
    ctx.fillStyle = random() > 0.45 ? '#343946' : '#ece8d2';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const texture = new T.CanvasTexture(canvas);
  if (T.SRGBColorSpace) texture.colorSpace = T.SRGBColorSpace;
  return texture;
}

function toCanvasLonLat(width, height, lon, lat) {
  return [((lon + 180) / 360) * width, ((90 - lat) / 180) * height];
}

function createNightLightsTexture(T) {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#02040a';
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'lighter';
  const random = seededNoise(0x510c1a);
  NIGHT_LIGHTS.forEach(({ lat, lon, scale }) => {
    const [x, y] = toCanvasLonLat(width, height, lon, lat);
    const size = scale || 1;
    const clusterRadius = 4.8 * size;
    const softGlow = ctx.createRadialGradient(x, y, 0, x, y, clusterRadius * 3.8);
    softGlow.addColorStop(0, 'rgba(255, 197, 118, .12)');
    softGlow.addColorStop(0.42, 'rgba(255, 154, 82, .045)');
    softGlow.addColorStop(1, 'rgba(255, 151, 70, 0)');
    ctx.fillStyle = softGlow;
    ctx.beginPath();
    ctx.arc(x, y, clusterRadius * 3.8, 0, Math.PI * 2);
    ctx.fill();

    const dots = Math.max(10, Math.round(18 * size));
    for (let i = 0; i < dots; i += 1) {
      const angle = random() * Math.PI * 2;
      const distance = Math.pow(random(), 1.8) * clusterRadius;
      const px = x + Math.cos(angle) * distance;
      const py = y + Math.sin(angle) * distance * 0.62;
      const radius = 0.34 + random() * 0.72 * size;
      const dot = ctx.createRadialGradient(px, py, 0, px, py, radius * 2.6);
      dot.addColorStop(0, 'rgba(255, 230, 176, .72)');
      dot.addColorStop(0.55, 'rgba(255, 178, 99, .18)');
      dot.addColorStop(1, 'rgba(255, 178, 99, 0)');
      ctx.fillStyle = dot;
      ctx.beginPath();
      ctx.arc(px, py, radius * 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  CHINA_CITIES.forEach(({ lat, lon, scale }) => {
    const [x, y] = toCanvasLonLat(width, height, lon, lat);
    const radius = 1.2 * (scale || 1);
    const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 3.2);
    glow.addColorStop(0, 'rgba(255, 222, 154, .34)');
    glow.addColorStop(0.5, 'rgba(255, 171, 92, .09)');
    glow.addColorStop(1, 'rgba(255, 151, 70, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, radius * 3.2, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalCompositeOperation = 'source-over';
  const texture = new T.CanvasTexture(canvas);
  if (T.SRGBColorSpace) texture.colorSpace = T.SRGBColorSpace;
  return texture;
}

function createLabelTexture(T, title, toneColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const color = `#${toneColor.toString(16).padStart(6, '0')}`;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(5, 9, 16, 0.72)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  const r = 22;
  ctx.beginPath();
  ctx.moveTo(r, 10);
  ctx.lineTo(canvas.width - r, 10);
  ctx.quadraticCurveTo(canvas.width - 10, 10, canvas.width - 10, r);
  ctx.lineTo(canvas.width - 10, canvas.height - r);
  ctx.quadraticCurveTo(canvas.width - 10, canvas.height - 10, canvas.width - r, canvas.height - 10);
  ctx.lineTo(r, canvas.height - 10);
  ctx.quadraticCurveTo(10, canvas.height - 10, 10, canvas.height - r);
  ctx.lineTo(10, r);
  ctx.quadraticCurveTo(10, 10, r, 10);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(38, 48, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#edf3ff';
  ctx.font = '700 26px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(title || '态势'), 58, 48, 300);
  const texture = new T.CanvasTexture(canvas);
  if (T.SRGBColorSpace) texture.colorSpace = T.SRGBColorSpace;
  return texture;
}

function drawFallbackOrbitNode(ctx, size, toneColor) {
  const color = `#${toneColor.toString(16).padStart(6, '0')}`;
  const center = size / 2;
  const glow = ctx.createRadialGradient(center, center, 0, center, center, size * 0.42);
  glow.addColorStop(0, `${color}ff`);
  glow.addColorStop(0.26, `${color}aa`);
  glow.addColorStop(0.62, `${color}22`);
  glow.addColorStop(1, `${color}00`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(center, center, size * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  ctx.arc(center, center, size * 0.24, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(center, center, size * 0.085, 0, Math.PI * 2);
  ctx.fill();
}

function createOrbitNodeTexture(T, atlasTex, index = 0, toneColor = 0x9ece6a) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const source = atlasTex?.image;
  if (source?.width && source?.height) {
    const cellWidth = Math.floor(source.width / ORBIT_NODE_ATLAS_CELLS);
    const cellIndex = Math.max(0, Math.min(ORBIT_NODE_ATLAS_CELLS - 1, index % ORBIT_NODE_ATLAS_CELLS));
    const side = Math.min(cellWidth, source.height);
    const sx = cellWidth * cellIndex + Math.max(0, (cellWidth - side) / 2);
    const sy = Math.max(0, (source.height - side) / 2);
    ctx.drawImage(source, sx, sy, side, side, 0, 0, size, size);
    const image = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < image.data.length; i += 4) {
      const max = Math.max(image.data[i], image.data[i + 1], image.data[i + 2]);
      const alpha = Math.max(0, Math.min(255, (max - 8) * 1.45));
      image.data[i + 3] = alpha;
    }
    ctx.putImageData(image, 0, 0);
  } else {
    drawFallbackOrbitNode(ctx, size, toneColor);
  }
  const texture = new T.CanvasTexture(canvas);
  if (T.SRGBColorSpace) texture.colorSpace = T.SRGBColorSpace;
  return texture;
}

function buildOrbitNodeMarker(T, toneColor, index = 0, atlasTex = null) {
  const group = new T.Group();
  const color = new T.Color(toneColor);
  const nodeTex = createOrbitNodeTexture(T, atlasTex, index, toneColor);
  const sprite = nodeTex ? new T.Sprite(new T.SpriteMaterial({
    map: nodeTex,
    transparent: true,
    opacity: 0.98,
    depthWrite: false,
    depthTest: false,
    blending: T.AdditiveBlending || T.NormalBlending,
  })) : null;
  if (sprite) sprite.scale.set(0.142, 0.142, 1);
  const halo = new T.Mesh(
    new T.TorusGeometry(0.052, 0.0024, 10, 72),
    new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.58, depthWrite: false, depthTest: false }),
  );
  const outerArc = new T.Mesh(
    new T.TorusGeometry(0.07, 0.0019, 10, 72, Math.PI * 1.42),
    new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.52, depthWrite: false, depthTest: false }),
  );
  const innerArc = new T.Mesh(
    new T.TorusGeometry(0.038, 0.0016, 10, 48, Math.PI * 1.18),
    new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.42, depthWrite: false, depthTest: false }),
  );
  const core = new T.Mesh(
    new T.SphereGeometry(0.014, 24, 24),
    new T.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthTest: false, depthWrite: false }),
  );
  group.add(halo, outerArc, innerArc, core);
  if (sprite) group.add(sprite);
  group.userData.noePulse = 0.9 + index * 0.18;
  group.userData.noeOrbitRings = { halo, outerArc, innerArc, sprite };
  return group;
}

function solarSubpoint(now = new Date()) {
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const day = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - start) / 86400000);
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  const lat = 23.44 * Math.sin((2 * Math.PI * (day - 81)) / 365);
  const lon = ((12 - utcHours) * 15 + 540) % 360 - 180;
  return { lat, lon };
}

function geoUnitVector(T, lat, lon) {
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;
  return new T.Vector3(
    Math.cos(latRad) * Math.cos(lonRad),
    Math.sin(latRad),
    Math.cos(latRad) * Math.sin(lonRad),
  ).normalize();
}

function geoToSpherePoint(T, lat, lon, radius = 1.028) {
  const v = geoUnitVector(T, lat, lon);
  return v.multiplyScalar(radius);
}

function createEarthDayNightMaterial(T, dayMap) {
  const nightMap = createNightLightsTexture(T);
  return new T.ShaderMaterial({
    depthTest: true,
    depthWrite: true,
    transparent: false,
    uniforms: {
      dayMap: { value: dayMap || createProceduralEarthTexture(T) },
      nightMap: { value: nightMap || createNightLightsTexture(T) || dayMap },
      sunDirection: { value: geoUnitVector(T, 0, 0) },
      atmosphereTint: { value: new T.Color(0x86b7ff) },
      visualLightDirection: { value: new T.Vector3(-0.48, 0.34, 0.81).normalize() },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vViewNormal;
      void main() {
        vUv = uv;
        vViewNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D dayMap;
      uniform sampler2D nightMap;
      uniform vec3 sunDirection;
      uniform vec3 atmosphereTint;
      uniform vec3 visualLightDirection;
      varying vec2 vUv;
      varying vec3 vViewNormal;
      const float PI = 3.141592653589793;
      void main() {
        float lon = (vUv.x - 0.5) * 2.0 * PI;
        float lat = (0.5 - vUv.y) * PI;
        vec3 geoNormal = normalize(vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon)));
        float day = smoothstep(-0.08, 0.22, dot(geoNormal, normalize(sunDirection)));
        vec3 viewNormal = normalize(vViewNormal);
        vec3 viewLight = normalize(visualLightDirection);
        float visualDay = smoothstep(-0.24, 0.54, dot(viewNormal, viewLight));
        vec3 earthDay = texture2D(dayMap, vUv).rgb;
        vec3 cityNight = texture2D(nightMap, vUv).rgb;
        vec3 nightBase = earthDay * 0.14 + cityNight * 0.92;
        float limb = pow(1.0 - max(dot(viewNormal, vec3(0.0, 0.0, 1.0)), 0.0), 2.2);
        float specular = pow(max(dot(reflect(-viewLight, viewNormal), vec3(0.0, 0.0, 1.0)), 0.0), 30.0) * visualDay;
        float dawn = smoothstep(-0.12, 0.2, day) * (1.0 - smoothstep(0.52, 0.96, day));
        vec3 litDay = earthDay * (0.74 + visualDay * 0.64);
        vec3 color = mix(nightBase, litDay, max(day * 0.78, visualDay * 0.54));
        color += vec3(1.0, 0.72, 0.42) * dawn * 0.09;
        color += vec3(0.72, 0.88, 1.0) * specular * 0.46;
        color += atmosphereTint * limb * (0.18 + visualDay * 0.08);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
}

function applyOrbitPlane(T, vec, plane = {}) {
  return vec.applyEuler(new T.Euler(
    Number(plane.inclination) || 0,
    Number(plane.node) || 0,
    Number(plane.roll) || 0,
    'XYZ',
  ));
}

function orbitToVec3(T, angle, lane, radius = 1.5, plane = {}) {
  const a = angle * (Math.PI / 180);
  const laneOffset = Number.isFinite(Number(lane)) ? Math.max(-0.18, Math.min(0.18, Number(lane))) : 0;
  const base = new T.Vector3(
    Math.cos(a) * radius,
    Math.sin(a) * (0.48 + Math.abs(laneOffset) * 0.14) + laneOffset,
    Math.sin(a) * (0.58 + Math.abs(laneOffset) * 0.26),
  );
  return applyOrbitPlane(T, base, plane);
}

function orbitPoints(T, lane, radius = 1.5, plane = {}) {
  const points = [];
  for (let a = 0; a < 360; a += 4) points.push(orbitToVec3(T, a, lane, radius, plane));
  return points;
}

function disposeObject(object) {
  object.traverse?.((child) => {
    if (child.geometry) child.geometry.dispose?.();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.filter(Boolean).forEach((material) => {
      if (material.map) material.map.dispose?.();
      material.dispose?.();
    });
  });
}

function normalizeHotspot(point, index) {
  const hasGeo = point.placement === 'geo'
    && Number.isFinite(Number(point.lat))
    && Number.isFinite(Number(point.lon));
  return {
    id: String(point.id || `hotspot-${index}`),
    title: String(point.title || point.id || `hotspot-${index}`),
    tone: TONE_COLORS[point.tone] ? point.tone : 'idle',
    placement: hasGeo ? 'geo' : 'orbit',
    lat: hasGeo ? Number(point.lat) : 0,
    lon: hasGeo ? Number(point.lon) : 0,
    orbitAngle: Number.isFinite(Number(point.orbitAngle)) ? Number(point.orbitAngle) : index * 58 - 116,
    orbitLane: Number.isFinite(Number(point.orbitLane)) ? Number(point.orbitLane) : null,
    orbitRadius: Number.isFinite(Number(point.orbitRadius))
      ? Math.max(1.08, Math.min(1.78, Number(point.orbitRadius)))
      : null,
    orbitPlaneIndex: Number.isFinite(Number(point.orbitPlaneIndex))
      ? Math.max(0, Math.floor(Number(point.orbitPlaneIndex)))
      : null,
    orbitSpeed: Number.isFinite(Number(point.orbitSpeed))
      ? Math.max(-0.004, Math.min(0.004, Number(point.orbitSpeed)))
      : null,
  };
}

export class NoeWorldEarth {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.earth = null;
    this.clouds = null;
    this.atmo = null;
    this.atmo2 = null;
    this.stars = null;
    this.moonGroup = null;
    this.moon = null;
    this.moonOrbitLine = null;
    this.chinaOverlay = null;
    this.userLocationMarker = null;
    this.sunUniform = null;
    this.lastSunUpdate = 0;
    this.hotspotGroup = null;
    this.routeGroup = null;
    this.orbitNodeAtlasTex = null;
    this.orbitNodeRecords = [];
    this.orbitPickTargets = [];
    this.orbitStartTime = 0;
    this.raycaster = null;
    this.pointer = null;
    this.downPoint = null;
    this.hotspots = [];
    this.selectedId = null;

    this.isDragging = false;
    this.prevMouse = { x: 0, y: 0 };
    this.rotX = 0.08;
    this.rotY = -0.62;
    this.velX = 0;
    this.velY = 0.0008;
    this.targetRotX = null;
    this.targetRotY = null;

    this.camDist = 3.7;
    this.camDistMin = 2.25;
    this.camDistMax = 4.35;
    this.appearing = false;
    this.appearScale = 0;
    this.animFrame = null;
    this._bound = {};
  }

  async init() {
    const T = await loadThree();
    this.scene = new T.Scene();
    const width = this.canvas.clientWidth || 640;
    const height = this.canvas.clientHeight || 360;
    this.camera = new T.PerspectiveCamera(43, width / height, 0.1, 100);
    this.camera.position.set(0, 0, this.camDist);

    this.renderer = new T.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    if (T.SRGBColorSpace) this.renderer.outputColorSpace = T.SRGBColorSpace;
    if (T.ACESFilmicToneMapping) {
      this.renderer.toneMapping = T.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.12;
    }

    const sun = new T.DirectionalLight(0xffffff, 2.35);
    sun.position.set(5, 2.2, 4.5);
    this.scene.add(sun);
    this.scene.add(new T.HemisphereLight(0xdcecff, 0x111827, 0.74));
    this.scene.add(new T.AmbientLight(0xffffff, 0.18));

    const loader = new T.TextureLoader();
    const load = (url) => new Promise((resolve) => loader.load(url, resolve, undefined, () => resolve(null)));
    const [earthTex, normalTex, specTex, cloudTex, moonTex, spaceTex, orbitNodeTex] = await Promise.all([
      load(TEX.earth),
      load(TEX.normal),
      load(TEX.specular),
      load(TEX.clouds),
      load(TEX.moon),
      load(TEX.space),
      load(TEX.orbitNodes),
    ]);
    [earthTex, cloudTex, moonTex, spaceTex, orbitNodeTex].forEach((tex) => {
      if (tex && T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;
    });
    this.orbitNodeAtlasTex = orbitNodeTex || null;
    this.scene.background = spaceTex || new T.Color(0x02060d);
    if (moonTex) {
      moonTex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy?.() || 1);
      moonTex.wrapS = T.RepeatWrapping;
      moonTex.wrapT = T.ClampToEdgeWrapping;
    }
    const earthGeo = new T.SphereGeometry(1, 64, 64);
    void normalTex;
    void specTex;
    const earthMat = createEarthDayNightMaterial(T, earthTex || createProceduralEarthTexture(T));
    this.sunUniform = earthMat.uniforms.sunDirection;
    this._updateSunDirection(T, true);
    this.earth = new T.Mesh(earthGeo, earthMat);
    this.scene.add(this.earth);

    if (cloudTex) {
      const cloudGeo = new T.SphereGeometry(1.012, 48, 48);
      const cloudMat = new T.MeshPhongMaterial({
        map: cloudTex,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
        emissive: new T.Color(0x666666),
      });
      this.clouds = new T.Mesh(cloudGeo, cloudMat);
      this.scene.add(this.clouds);
    }

    const atmoGeo = new T.SphereGeometry(1.06, 32, 32);
    this.atmo = new T.Mesh(atmoGeo, new T.MeshBasicMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.065,
      side: T.BackSide,
      depthWrite: false,
    }));
    this.scene.add(this.atmo);
    this.atmo2 = new T.Mesh(new T.SphereGeometry(1.035, 32, 32), new T.MeshBasicMaterial({
      color: 0x88ccff,
      transparent: true,
      opacity: 0.038,
      side: T.FrontSide,
      depthWrite: false,
    }));
    this.scene.add(this.atmo2);

    this.stars = this._buildStars(T);
    this.scene.add(this.stars);
    this.moonGroup = this._buildMoon(T, moonTex);
    this.scene.add(this.moonGroup);
    this.chinaOverlay = this._buildChinaOverlay(T);
    this.chinaOverlay.visible = false;
    this.earth.add(this.chinaOverlay);
    this.hotspotGroup = new T.Group();
    this.routeGroup = new T.Group();
    this.earth.add(this.routeGroup);
    this.scene.add(this.hotspotGroup);
    this.raycaster = new T.Raycaster();
    this.pointer = new T.Vector2();

    this._setScaled(0);
    this._bindEvents();
    this.orbitStartTime = performance.now();
    this._animate();
    this.triggerAppear();
  }

  setHotspots(points = []) {
    const T = THREE;
    if (!T || !this.hotspotGroup || !this.routeGroup) return;
    this.hotspots = points.map(normalizeHotspot);
    while (this.hotspotGroup.children.length) {
      const child = this.hotspotGroup.children.pop();
      if (child) disposeObject(child);
    }
    while (this.routeGroup.children.length) {
      const child = this.routeGroup.children.pop();
      if (child) disposeObject(child);
    }
    this.orbitNodeRecords = [];
    this.orbitPickTargets = [];

    this._buildOrbitNodes(T);
    this.setSelectedHotspot(this.selectedId || this.hotspots[0]?.id || null, { focus: false });
  }

  setSelectedHotspot(id, { focus = true } = {}) {
    this.selectedId = id || null;
    this.orbitNodeRecords.forEach(({ marker, label, point }) => {
      const selected = point.id === this.selectedId;
      marker.userData.selectedScale = selected ? 1.16 : 1;
      marker.scale.setScalar(marker.userData.selectedScale);
      if (label?.material) label.material.opacity = selected ? 0.96 : 0.78;
    });
    if (focus && this.selectedId) this.focusHotspot(this.selectedId);
  }

  focusHotspot(id) {
    const point = this.hotspots.find((item) => item.id === id);
    if (!point) return;
    if (point.placement !== 'geo') {
      this.targetRotX = null;
      this.targetRotY = null;
      this.velX = 0;
      this.velY = 0;
      return;
    }
    this.targetRotX = Math.max(-Math.PI / 2.25, Math.min(Math.PI / 2.25, -point.lat * Math.PI / 360));
    this.targetRotY = -((point.lon + 180) * Math.PI / 180) + Math.PI / 2;
    this.velX = 0;
    this.velY = 0;
  }

  focusChina() {
    if (this.chinaOverlay) this.chinaOverlay.visible = true;
    this.targetRotX = -34 * Math.PI / 360;
    this.targetRotY = -((104 + 180) * Math.PI / 180) + Math.PI / 2;
    this.camDist = Math.max(this.camDistMin, Math.min(this.camDistMax, 2.48));
    this.velX = 0;
    this.velY = 0;
  }

  resetEarthView() {
    if (this.chinaOverlay) this.chinaOverlay.visible = false;
    this.targetRotX = 0.08;
    this.targetRotY = -0.62;
    this.camDist = 3.7;
    this.velX = 0;
    this.velY = 0;
  }

  setUserLocation(location = {}) {
    const T = THREE;
    if (!T || !this.chinaOverlay) return;
    const lat = Number(location.lat);
    const lon = Number(location.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    this.chinaOverlay.visible = true;
    if (this.userLocationMarker) {
      this.chinaOverlay.remove(this.userLocationMarker);
      disposeObject(this.userLocationMarker);
    }
    const marker = new T.Group();
    const core = new T.Mesh(
      new T.SphereGeometry(0.018, 24, 24),
      new T.MeshBasicMaterial({ color: 0xffd166, depthTest: true }),
    );
    const halo = new T.Mesh(
      new T.SphereGeometry(0.031, 24, 24),
      new T.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    marker.add(halo, core);
    marker.position.copy(geoToSpherePoint(T, lat, lon, 1.048));
    marker.lookAt(new T.Vector3(0, 0, 0));
    this.chinaOverlay.add(marker);
    this.userLocationMarker = marker;
    this.targetRotX = Math.max(-Math.PI / 2.25, Math.min(Math.PI / 2.25, -lat * Math.PI / 360));
    this.targetRotY = -((lon + 180) * Math.PI / 180) + Math.PI / 2;
    this.camDist = Math.max(this.camDistMin, Math.min(this.camDistMax, 2.42));
    this.velX = 0;
    this.velY = 0;
  }

  triggerAppear() {
    this.appearing = true;
    this.appearScale = 0;
    this._setScaled(0);
  }

  pause() {
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = null;
    }
  }

  resume() {
    if (!this.animFrame && this.renderer) this._animate();
  }

  dispose() {
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    const c = this.canvas;
    const b = this._bound;
    if (b.pointer) {
      if (b.onDown) c.removeEventListener('pointerdown', b.onDown);
      if (b.onMove) c.removeEventListener('pointermove', b.onMove);
      if (b.onUp) c.removeEventListener('pointerup', b.onUp);
      if (b.onUp) c.removeEventListener('pointercancel', b.onUp);
      if (b.onUp) c.removeEventListener('pointerleave', b.onUp);
    } else {
      if (b.onDown) c.removeEventListener('mousedown', b.onDown);
      if (b.onMove) c.removeEventListener('mousemove', b.onMove);
      if (b.onUp) c.removeEventListener('mouseup', b.onUp);
      if (b.onUp) c.removeEventListener('mouseleave', b.onUp);
      if (b.onDown) c.removeEventListener('touchstart', b.onDown);
      if (b.onMove) c.removeEventListener('touchmove', b.onMove);
      if (b.onUp) c.removeEventListener('touchend', b.onUp);
    }
    if (b.onWheel) c.removeEventListener('wheel', b.onWheel);
    this.renderer?.dispose();
    this.renderer = null;
  }

  _buildStars(T) {
    const random = seededNoise(0x0e100);
    const starVerts = [];
    const starColors = [];
    const starSizes = [];
    for (let i = 0; i < 1800; i += 1) {
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      const radius = 16 + random() * 18;
      starVerts.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta),
      );
      const warmth = random();
      starColors.push(
        warmth > 0.82 ? 1 : 0.82 + random() * 0.18,
        warmth > 0.62 ? 0.88 + random() * 0.12 : 0.92 + random() * 0.08,
        warmth > 0.82 ? 0.76 + random() * 0.14 : 1,
      );
      starSizes.push(random() > 0.99 ? 1.45 : 0.52 + random() * 0.48);
    }
    const starGeo = new T.BufferGeometry();
    starGeo.setAttribute('position', new T.Float32BufferAttribute(starVerts, 3));
    starGeo.setAttribute('color', new T.Float32BufferAttribute(starColors, 3));
    starGeo.setAttribute('size', new T.Float32BufferAttribute(starSizes, 1));
    const starMat = new T.PointsMaterial({
      color: 0xffffff,
      vertexColors: true,
      size: 0.026,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.34,
    });
    return new T.Points(starGeo, starMat);
  }

  _buildOrbitNodes(T) {
    if (!this.hotspotGroup || !this.routeGroup) return;
    this.hotspots.forEach((point, index) => {
      const color = TONE_COLORS[point.tone] || TONE_COLORS.idle;
      const lane = point.orbitLane ?? ((index % 3) - 1) * 0.08;
      const radius = point.orbitRadius ?? (1.3 + (index % 3) * 0.048);
      const planeIndex = point.orbitPlaneIndex ?? index;
      const plane = ORBIT_PLANES[planeIndex % ORBIT_PLANES.length];
      const track = new T.LineLoop(
        new T.BufferGeometry().setFromPoints(orbitPoints(T, lane, radius, plane)),
        new T.LineBasicMaterial({ color, transparent: true, opacity: point.id === this.selectedId ? 0.2 : 0.075, depthWrite: false, depthTest: false }),
      );
      this.hotspotGroup.add(track);

      const marker = new T.Group();
      const node = buildOrbitNodeMarker(T, color, index, this.orbitNodeAtlasTex);
      const pick = new T.Mesh(
        new T.SphereGeometry(0.15, 18, 18),
        new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.001, depthWrite: false, depthTest: false }),
      );
      const labelTex = createLabelTexture(T, point.title, color);
      const label = labelTex ? new T.Sprite(new T.SpriteMaterial({
        map: labelTex,
        transparent: true,
        opacity: 0.62,
        depthTest: false,
        depthWrite: false,
      })) : null;
      const leader = label ? new T.Line(
        new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]),
        new T.LineBasicMaterial({ color, transparent: true, opacity: 0.24, depthWrite: false, depthTest: false }),
      ) : null;
      marker.add(node, pick);
      marker.userData.noeHotspotId = point.id;
      marker.userData.orbitLane = lane;
      marker.userData.orbitRadius = radius;
      marker.userData.orbitPlane = plane;
      marker.userData.orbitAngle = point.orbitAngle;
      marker.userData.orbitSpeed = point.orbitSpeed ?? (0.00044 + index * 0.000018);
      marker.userData.selectedScale = point.id === this.selectedId ? 1.16 : 1;
      this.hotspotGroup.add(marker);
      if (label) {
        label.scale.set(0.48, 0.12, 1);
        label.userData.noeHotspotId = point.id;
        this.hotspotGroup.add(label);
      }
      if (leader) this.hotspotGroup.add(leader);
      this.orbitNodeRecords.push({ point, marker, node, label, track, leader });
      this.orbitPickTargets.push(pick);
    });
    this._updateOrbitNodePositions(T, performance.now());
  }

  _buildChinaOverlay(T) {
    const group = new T.Group();
    const lineGeo = new T.BufferGeometry().setFromPoints(CHINA_OUTLINE.map(([lon, lat]) => geoToSpherePoint(T, lat, lon, 1.034)));
    const line = new T.Line(lineGeo, new T.LineBasicMaterial({
      color: 0x4fd6ff,
      transparent: true,
      opacity: 0.88,
      depthTest: true,
      depthWrite: false,
    }));
    group.add(line);

    const cityMat = new T.MeshBasicMaterial({ color: 0x9ece6a, transparent: true, opacity: 0.9, depthTest: true });
    CHINA_CITIES.forEach(({ lat, lon, scale }) => {
      const dot = new T.Mesh(new T.SphereGeometry(0.0085 * (scale || 1), 14, 14), cityMat.clone());
      dot.position.copy(geoToSpherePoint(T, lat, lon, 1.045));
      group.add(dot);
    });
    return group;
  }

  _buildMoon(T, texture = null) {
    const group = new T.Group();
    group.rotation.x = -0.18;
    group.rotation.z = 0.1;
    const moonMat = new T.MeshPhongMaterial({
      map: texture || createMoonTexture(T) || undefined,
      color: 0xe3ded1,
      emissive: new T.Color(0x1e2230),
      emissiveIntensity: 0.12,
      shininess: 3,
      specular: new T.Color(0x161923),
    });
    const orbitX = 1.38;
    const orbitY = 0.82;
    const orbitZ = 0.62;
    const moonRadius = 0.098;
    const moonPhase = 0.64;
    this.moon = new T.Mesh(new T.SphereGeometry(moonRadius, 64, 64), moonMat);
    this.moon.userData.noeMoonRadius = moonRadius;
    this.moon.position.set(
      Math.cos(moonPhase) * orbitX,
      0.18 + Math.sin(moonPhase) * orbitY,
      Math.sin(moonPhase) * orbitZ,
    );

    this.moonOrbitLine = null;
    group.add(this.moon);
    return group;
  }

  _screenPoint(T, vec, width, height) {
    const projected = vec.clone().project(this.camera);
    return {
      x: (projected.x * 0.5 + 0.5) * width,
      y: (-projected.y * 0.5 + 0.5) * height,
      z: projected.z,
    };
  }

  _isPointOccludedByEarth(T, worldPoint, margin = 1.06) {
    if (!this.camera || !this.canvas || !this.earth) return false;
    const width = this.canvas.clientWidth || 640;
    const height = this.canvas.clientHeight || 360;
    this.camera.updateMatrixWorld(true);
    const earthScale = this.earth.scale?.x || 1;
    const centerWorld = new T.Vector3(0, 0, 0);
    const center = this._screenPoint(T, centerWorld, width, height);
    const edge = this._screenPoint(T, new T.Vector3(1.03 * earthScale, 0, 0), width, height);
    const earthRadiusPx = Math.hypot(edge.x - center.x, edge.y - center.y);
    const pointScreen = this._screenPoint(T, worldPoint, width, height);
    const distancePx = Math.hypot(pointScreen.x - center.x, pointScreen.y - center.y);
    const earthCamera = centerWorld.clone().applyMatrix4(this.camera.matrixWorldInverse);
    const pointCamera = worldPoint.clone().applyMatrix4(this.camera.matrixWorldInverse);
    return pointCamera.z < earthCamera.z && distancePx < earthRadiusPx * margin;
  }

  _isMoonInsideEarthDisc(T) {
    if (!this.camera || !this.canvas || !this.moon || !this.scene) return false;
    const width = this.canvas.clientWidth || 640;
    const height = this.canvas.clientHeight || 360;
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);

    const center = this._screenPoint(T, new T.Vector3(0, 0, 0), width, height);
    const earthScale = this.earth?.scale?.x || 1;
    const earthEdge = this._screenPoint(T, new T.Vector3(1.07 * earthScale, 0, 0), width, height);
    const earthRadiusPx = Math.hypot(earthEdge.x - center.x, earthEdge.y - center.y);

    const moonWorld = new T.Vector3();
    this.moon.getWorldPosition(moonWorld);
    const moonCenter = this._screenPoint(T, moonWorld, width, height);
    const moonRadius = Number(this.moon.userData.noeMoonRadius || 0.125) * (this.moonGroup?.scale?.x || 1);
    const moonEdgeWorld = moonWorld.clone().add(new T.Vector3(moonRadius, 0, 0));
    const moonEdge = this._screenPoint(T, moonEdgeWorld, width, height);
    const moonRadiusPx = Math.max(8, Math.hypot(moonEdge.x - moonCenter.x, moonEdge.y - moonCenter.y));
    const centerDistancePx = Math.hypot(moonCenter.x - center.x, moonCenter.y - center.y);
    const earthCamera = new T.Vector3(0, 0, 0).applyMatrix4(this.camera.matrixWorldInverse);
    const moonCamera = moonWorld.clone().applyMatrix4(this.camera.matrixWorldInverse);
    const moonBehindEarthCenter = moonCamera.z < earthCamera.z;

    return moonBehindEarthCenter && centerDistancePx < earthRadiusPx + moonRadiusPx * 1.18;
  }

  _updateMoonOcclusion(T) {
    if (!this.moon) return;
    void T;
    this.moon.visible = true;
  }

  _updateSunDirection(T, force = false) {
    if (!this.sunUniform) return;
    const now = Date.now();
    if (!force && now - this.lastSunUpdate < 60_000) return;
    this.lastSunUpdate = now;
    const sun = solarSubpoint(new Date(now));
    this.sunUniform.value.copy(geoUnitVector(T, sun.lat, sun.lon));
  }

  _bindEvents() {
    const c = this.canvas;
    const onDown = (event) => {
      if (event.cancelable) event.preventDefault();
      this.isDragging = true;
      const p = event.touches ? event.touches[0] : event;
      this.prevMouse = { x: p.clientX, y: p.clientY };
      this.downPoint = { x: p.clientX, y: p.clientY };
      this.velX = 0;
      this.velY = 0;
      this.targetRotX = null;
      this.targetRotY = null;
      if (event.pointerId !== undefined && c.setPointerCapture) {
        try { c.setPointerCapture(event.pointerId); } catch { /* capture is best effort */ }
      }
    };
    const onMove = (event) => {
      if (!this.isDragging) return;
      event.preventDefault();
      const p = event.touches ? event.touches[0] : event;
      const dx = p.clientX - this.prevMouse.x;
      const dy = p.clientY - this.prevMouse.y;
      this.velY = dx * 0.003;
      this.velX = dy * 0.003;
      this.rotY += this.velY;
      this.rotX += this.velX;
      this.rotX = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, this.rotX));
      this.prevMouse = { x: p.clientX, y: p.clientY };
    };
    const onUp = (event) => {
      const p = event.changedTouches ? event.changedTouches[0] : event;
      const moved = this.downPoint && p ? Math.hypot(p.clientX - this.downPoint.x, p.clientY - this.downPoint.y) : 999;
      this.isDragging = false;
      if (moved < 5) this._pickHotspot(event);
      this.downPoint = null;
      if (event?.pointerId !== undefined && c.releasePointerCapture) {
        try { c.releasePointerCapture(event.pointerId); } catch { /* capture is best effort */ }
      }
    };
    const onWheel = (event) => {
      event.preventDefault();
      this.camDist += event.deltaY * 0.002;
      this.camDist = Math.max(this.camDistMin, Math.min(this.camDistMax, this.camDist));
    };
    const pointer = 'PointerEvent' in window;
    if (pointer) {
      c.addEventListener('pointerdown', onDown);
      c.addEventListener('pointermove', onMove);
      c.addEventListener('pointerup', onUp);
      c.addEventListener('pointercancel', onUp);
      c.addEventListener('pointerleave', onUp);
    } else {
      c.addEventListener('mousedown', onDown);
      c.addEventListener('mousemove', onMove);
      c.addEventListener('mouseup', onUp);
      c.addEventListener('mouseleave', onUp);
      c.addEventListener('touchstart', onDown, { passive: false });
      c.addEventListener('touchmove', onMove, { passive: false });
      c.addEventListener('touchend', onUp);
    }
    c.addEventListener('wheel', onWheel, { passive: false });
    this._bound = { onDown, onMove, onUp, onWheel, pointer };
  }

  _setScaled(scale) {
    this.earth?.scale.setScalar(scale);
    this.clouds?.scale.setScalar(scale);
    this.atmo?.scale.setScalar(scale);
    this.atmo2?.scale.setScalar(scale);
    this.moonGroup?.scale.setScalar(Math.max(0.001, scale));
    this.hotspotGroup?.scale.setScalar(Math.max(0.001, scale));
    if (this.stars?.material) this.stars.material.opacity = Math.min(1, scale * 1.5);
  }

  _pickHotspot(event) {
    const T = THREE;
    if (!T || !this.raycaster || !this.pointer || !this.camera || !this.orbitPickTargets.length) return;
    const p = event.changedTouches ? event.changedTouches[0] : event;
    if (!p) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((p.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -(((p.clientY - rect.top) / rect.height) * 2 - 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.orbitPickTargets, true);
    const id = hits.find((hit) => hit.object?.parent?.userData?.noeHotspotId)?.object?.parent?.userData?.noeHotspotId;
    if (!id) return;
    this.canvas.dispatchEvent(new CustomEvent('noe-world-hotspot-select', { detail: { id } }));
  }

  _updateOrbitNodePositions(T, now) {
    this.orbitNodeRecords.forEach(({ point, marker, node, label, track, leader }, index) => {
      const elapsed = Math.max(0, now - (this.orbitStartTime || now));
      const speed = Number(marker.userData.orbitSpeed) || 0.00042;
      const angle = (Number(marker.userData.orbitAngle) || 0) + elapsed * speed * ORBIT_NODE_MOTION_GAIN;
      const lane = Number(marker.userData.orbitLane) || 0;
      const radius = Number(marker.userData.orbitRadius) || 1.5;
      const plane = marker.userData.orbitPlane || ORBIT_PLANES[0];
      marker.position.copy(orbitToVec3(T, angle, lane, radius, plane));
      marker.lookAt(this.camera.position);
      const selectedScale = Number(marker.userData.selectedScale || 1);
      const pulse = 1 + Math.sin(now * 0.003 + index) * 0.024;
      marker.scale.setScalar(selectedScale * pulse);
      const rings = node?.userData?.noeOrbitRings;
      if (rings) {
        const t = now * 0.001;
        const ringPulse = 1 + Math.sin(now * 0.0024 + index * 0.9) * 0.1;
        rings.halo.rotation.z = t * (0.45 + index * 0.03);
        rings.halo.scale.setScalar(0.94 + ringPulse * 0.06);
        rings.outerArc.rotation.z = t * (0.72 + index * 0.04) + index * 0.44;
        rings.outerArc.scale.setScalar(ringPulse);
        rings.innerArc.rotation.z = -t * (0.86 + index * 0.035) - index * 0.28;
        rings.innerArc.scale.setScalar(1.03 - (ringPulse - 1) * 0.55);
        if (rings.sprite?.material) rings.sprite.material.opacity = 0.82 + Math.sin(now * 0.002 + index) * 0.1;
      }
      marker.updateMatrixWorld(true);
      const markerWorld = new T.Vector3();
      marker.getWorldPosition(markerWorld);
      const occluded = false;
      const width = this.canvas?.clientWidth || 640;
      const height = this.canvas?.clientHeight || 360;
      const screen = this._screenPoint(T, markerWorld, width, height);
      const edgeSafe = screen.z > -1 && screen.z < 1
        && screen.x > -96 && screen.x < width + 96
        && screen.y > -82 && screen.y < height + 82;
      marker.visible = !occluded && edgeSafe;
      if (label) {
        const preset = ORBIT_LABEL_OFFSETS[point.id];
        const labelToRight = screen.x < width * 0.62;
        const labelUp = screen.y > height * 0.72 ? true : screen.y < height * 0.24 ? false : marker.position.y < 0;
        let labelX = preset ? preset[0] : (labelToRight ? 0.34 : -0.34);
        if (screen.x > width * 0.76) labelX = -Math.abs(labelX);
        if (screen.x < width * 0.22) labelX = Math.abs(labelX);
        const labelOffset = new T.Vector3(
          labelX,
          preset ? preset[1] : (labelUp ? 0.075 : -0.075),
          0.035,
        );
        label.position.copy(marker.position).add(labelOffset);
        label.visible = !occluded && edgeSafe;
      }
      if (leader) {
        leader.visible = !occluded && edgeSafe && Boolean(label);
        if (leader.visible && label) {
          leader.geometry.setFromPoints([marker.position.clone(), label.position.clone()]);
          leader.geometry.attributes.position.needsUpdate = true;
        }
      }
      if (track?.material) {
        track.material.opacity = marker.userData.noeHotspotId === this.selectedId ? 0.18 : 0.065;
      }
    });
  }

  _animate() {
    this.animFrame = requestAnimationFrame(() => this._animate());
    if (!this.renderer || !this.scene || !this.camera) return;

    if (this.appearing) {
      this.appearScale += (1 - this.appearScale) * 0.07;
      this._setScaled(this.appearScale);
      if (this.appearScale > 0.999) {
        this.appearing = false;
        this._setScaled(1);
      }
    }

    if (!this.isDragging) {
      this.velX *= 0.92;
      this.velY *= 0.92;
      if (this.targetRotX !== null && this.targetRotY !== null) {
        this.rotX += (this.targetRotX - this.rotX) * 0.08;
        this.rotY += (this.targetRotY - this.rotY) * 0.08;
        if (Math.abs(this.targetRotX - this.rotX) < 0.002 && Math.abs(this.targetRotY - this.rotY) < 0.002) {
          this.targetRotX = null;
          this.targetRotY = null;
        }
      } else {
        this.rotX += this.velX;
        this.rotY += this.velY + 0.00165;
      }
      this.rotX = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, this.rotX));
    }

    if (this.earth) {
      this.earth.rotation.x = this.rotX;
      this.earth.rotation.y = this.rotY;
    }
    if (this.clouds) {
      this.clouds.rotation.x = this.rotX;
      this.clouds.rotation.y = this.rotY + performance.now() * 0.000008;
    }
    if (this.moonGroup) this.moonGroup.rotation.y += 0.0022;
    if (this.moon) this.moon.rotation.y += 0.0045;
    this.stars.rotation.y += 0.00007;
    this._updateOrbitNodePositions(THREE, performance.now());
    const current = this.camera.position.length();
    this.camera.position.setLength(current + (this.camDist - current) * 0.1);
    this._checkResize();
    this._updateSunDirection(THREE);
    this._updateMoonOcclusion(THREE);
    this.renderer.render(this.scene, this.camera);
  }

  _checkResize() {
    if (!this.renderer || !this.camera) return;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!width || !height) return;
    const pixelRatio = this.renderer.getPixelRatio();
    if (this.canvas.width !== Math.round(width * pixelRatio) || this.canvas.height !== Math.round(height * pixelRatio)) {
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.setSelectedHotspot(this.selectedId, { focus: false });
    }
  }
}
