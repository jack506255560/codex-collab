import {
  BufferGeometry, Color, Float32BufferAttribute, NormalBlending,
  PerspectiveCamera, Points, Scene, ShaderMaterial, Vector2, WebGLRenderer,
} from '/vendor/three.module.js';

// Stars and pointer dust each render in a single draw call.
const canvas = document.getElementById('ambient-canvas');
const follower = document.getElementById('cursor-follower');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
const palettes = {
  day: ['#728f9e', '#9a8bb4', '#a2b7c5', .88],
  night: ['#8fbdbb', '#b5b0e2', '#c5d6e0', .88],
};
const pointer = { x: 0, y: 0, ringX: 0, ringY: 0, fieldX: 0, fieldY: 0, alpha: 0, active: false, hover: false, down: false };
const trailCount = 44;
const trailPositions = new Float32Array(trailCount * 3);
const trailBirths = new Float32Array(trailCount).fill(-100);
const trailSeeds = new Float32Array(trailCount);
let width = innerWidth, height = innerHeight, frame = 0, lastFrame = 0, elapsed = 0;
let renderer, scene, camera, stars, dust, starGeometry, dustGeometry;
let initialized = false, lost = false, trailIndex = 0, lastTrail = 0, lastTrailX = 0, lastTrailY = 0;
let density = 1;
const isStatic = () => reducedMotion.matches || !finePointer.matches;
const uniforms = {
  uTime: { value: 0 },
  uPixelRatio: { value: 1 },
  uSpan: { value: new Vector2(1, 1) },
  uPointer: { value: new Vector2() },
  uParallax: { value: new Vector2() },
  uPointerAlpha: { value: 0 },
  uColorA: { value: new Color() },
  uColorB: { value: new Color() },
  uColorC: { value: new Color() },
  uOpacity: { value: 1 },
};

const starVertex = `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform vec2 uSpan;
  uniform vec2 uPointer;
  uniform vec2 uParallax;
  uniform float uPointerAlpha;
  attribute float aSize;
  attribute float aPhase;
  attribute float aTone;
  varying float vTone;
  varying float vAlpha;
  varying float vSparkle;
  void main() {
    float depth = (8.0 - position.z) / 8.0;
    vec3 p = vec3(position.xy * uSpan * depth, position.z);
    p.x += sin(uTime * .085 + aPhase) * .065;
    p.y += cos(uTime * .065 + aPhase * 1.3) * .045;
    // Farther layers respond less, creating subtle depth without camera sway.
    p.xy += uParallax * (.025 + (position.z + 4.0) * .012);
    vec2 delta = uPointer * depth - p.xy;
    float proximity = exp(-dot(delta, delta) / (1.1 * depth * depth));
    p.xy += delta * proximity * .09 * uPointerAlpha;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec4 projected = projectionMatrix * mv;
    gl_Position = projected;
    gl_PointSize = clamp(aSize * uPixelRatio * (8.0 / -mv.z), 2.0, 28.0 * uPixelRatio);
    vec2 screen = projected.xy / projected.w;
    float quietCenter = 1.0 - exp(-pow(screen.x * 2.2, 2.0) - pow(screen.y * 1.6, 2.0)) * .45;
    vAlpha = (.74 + sin(uTime * .42 + aPhase) * .18) * quietCenter;
    vTone = aTone;
    vSparkle = step(.83, aTone);
  }
`;
const starFragment = `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  uniform float uOpacity;
  varying float vTone;
  varying float vAlpha;
  varying float vSparkle;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float radius = dot(p, p);
    if (radius > 1.0) discard;
    float core = exp(-radius * 80.0);
    float halo = exp(-radius * 6.0) * .2;
    float cross = (exp(-abs(p.x) * 65.0) + exp(-abs(p.y) * 65.0)) * exp(-radius * 7.0) * .21 * vSparkle;
    float alpha = (core + halo + cross) * vAlpha * uOpacity;
    vec3 color = mix(uColorA, uColorB, smoothstep(.1, .8, vTone));
    color = mix(color, uColorC, vSparkle * .55);
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`;
const dustVertex = `
  uniform float uTime;
  uniform float uPixelRatio;
  attribute float aBirth;
  attribute float aSeed;
  varying float vAlpha;
  void main() {
    float age = uTime - aBirth;
    float life = clamp(1.0 - age / 1.25, 0.0, 1.0);
    vec3 p = position;
    p.x += sin(aSeed * 25.0) * age * .042;
    p.y += age * (.035 + aSeed * .035);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = (6.0 + aSeed * 7.0) * uPixelRatio * (.7 + life * .3);
    vAlpha = life * life * .65;
  }
`;
const dustFragment = `
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  uniform float uOpacity;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float radius = dot(p, p);
    if (radius > 1.0) discard;
    float softPoint = exp(-radius * 35.0) + exp(-radius * 5.0) * .12;
    gl_FragColor = vec4(mix(uColorB, uColorC, .4), softPoint * vAlpha * uOpacity);
    #include <colorspace_fragment>
  }
`;

function stop() {
  cancelAnimationFrame(frame);
  frame = 0;
  lastFrame = 0;
}
function schedule() {
  if (renderer && !frame && !document.hidden && !isStatic() && !lost) frame = requestAnimationFrame(tick);
}
function createScene() {
  if (initialized) return;
  initialized = true;
  try {
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'low-power' });
    renderer.setClearColor(0x000000, 0);
    scene = new Scene();
    camera = new PerspectiveCamera(42, width / height, .1, 30);
    camera.position.z = 8;
    starGeometry = new BufferGeometry();
    const positions = [], sizes = [], phases = [], tones = [];
    let seed = 173;
    const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    for (let i = 0; i < 148; i++) {
      positions.push((random() - .5) * 1.18, (random() - .5) * 1.18, random() * 6.5 - 4);
      sizes.push(6 + Math.pow(random(), 2) * 13);
      phases.push(random() * Math.PI * 2);
      tones.push(random());
    }
    starGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    starGeometry.setAttribute('aSize', new Float32BufferAttribute(sizes, 1));
    starGeometry.setAttribute('aPhase', new Float32BufferAttribute(phases, 1));
    starGeometry.setAttribute('aTone', new Float32BufferAttribute(tones, 1));
    const settings = { uniforms, transparent: true, depthTest: false, depthWrite: false, blending: NormalBlending };
    stars = new Points(starGeometry, new ShaderMaterial({ ...settings, vertexShader: starVertex, fragmentShader: starFragment }));
    stars.frustumCulled = false;
    dustGeometry = new BufferGeometry();
    dustGeometry.setAttribute('position', new Float32BufferAttribute(trailPositions, 3));
    dustGeometry.setAttribute('aBirth', new Float32BufferAttribute(trailBirths, 1));
    for (let i = 0; i < trailCount; i++) trailSeeds[i] = random();
    dustGeometry.setAttribute('aSeed', new Float32BufferAttribute(trailSeeds, 1));
    dust = new Points(dustGeometry, new ShaderMaterial({ ...settings, vertexShader: dustVertex, fragmentShader: dustFragment }));
    dust.frustumCulled = false;
    scene.add(stars, dust);
    document.documentElement.dataset.webgl = 'ready';
    resizeRenderer();
  } catch {
    disposeScene();
    // CSS keeps a quiet star field if WebGL is unavailable.
    document.documentElement.dataset.webgl = 'fallback';
  }
}
function disposeScene() {
  starGeometry?.dispose(); dustGeometry?.dispose();
  stars?.material.dispose(); dust?.material.dispose();
  renderer?.dispose();
  renderer = null;
}
function resizeRenderer() {
  if (!renderer) return;
  density = Math.min(devicePixelRatio || 1, 1.5, 2048 / Math.max(width, height));
  renderer.setPixelRatio(density);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  const spanY = 2 * Math.tan(42 * Math.PI / 360) * 8;
  uniforms.uSpan.value.set(spanY * camera.aspect, spanY);
  uniforms.uPixelRatio.value = density;
  starGeometry.setDrawRange(0, Math.min(148, Math.max(65, Math.round(width * height / 9500))));
}
function render() {
  if (renderer && !lost) renderer.render(scene, camera);
}
function updatePalette() {
  const colors = palettes[document.body.dataset.theme] || palettes.day;
  uniforms.uColorA.value.set(colors[0]);
  uniforms.uColorB.value.set(colors[1]);
  uniforms.uColorC.value.set(colors[2]);
  uniforms.uOpacity.value = colors[3];
  render();
}
function clearDust() {
  trailBirths.fill(-100);
  if (dustGeometry) {
    dustGeometry.getAttribute('aBirth').array.set(trailBirths);
    dustGeometry.getAttribute('aBirth').needsUpdate = true;
  }
}
function updatePreferences() {
  stop();
  const staticMode = isStatic();
  document.documentElement.dataset.effectsPaused = String(document.hidden);
  document.documentElement.dataset.effectsStatic = String(staticMode);
  // Touch/reduced-motion starts with CSS alone; no WebGL context or render loop.
  if (!staticMode) createScene();
  if (staticMode) {
    pointer.alpha = 0;
    uniforms.uPointerAlpha.value = 0;
    clearDust();
    render();
  }
  updatePalette();
  schedule();
}
function follow(dt) {
  const ease = 1 - Math.exp(-dt / 90);
  const slow = 1 - Math.exp(-dt / 300);
  pointer.ringX += (pointer.x - pointer.ringX) * ease;
  pointer.ringY += (pointer.y - pointer.ringY) * ease;
  pointer.fieldX += (pointer.x - pointer.fieldX) * slow;
  pointer.fieldY += (pointer.y - pointer.fieldY) * slow;
  pointer.alpha += ((pointer.active ? 1 : 0) - pointer.alpha) * ease;
  const scale = pointer.down ? .72 : pointer.hover ? 1.35 : 1;
  follower.style.transform = `translate3d(${pointer.ringX - 15}px, ${pointer.ringY - 15}px, 0) scale(${scale})`;
  follower.style.opacity = String(pointer.alpha * (pointer.hover ? .35 : .8));
  const span = uniforms.uSpan.value;
  uniforms.uPointer.value.set((pointer.fieldX / width - .5) * span.x, (.5 - pointer.fieldY / height) * span.y);
  uniforms.uPointerAlpha.value = pointer.alpha;
  const targetX = pointer.active ? (pointer.x / width - .5) * span.x : 0;
  const targetY = pointer.active ? (.5 - pointer.y / height) * span.y : 0;
  const parallax = uniforms.uParallax.value;
  parallax.x += (targetX - parallax.x) * slow;
  parallax.y += (targetY - parallax.y) * slow;
}
function addDust(now) {
  if (!dustGeometry || now - lastTrail < 28 || Math.hypot(pointer.x - lastTrailX, pointer.y - lastTrailY) < 5) return;
  const span = uniforms.uSpan.value;
  const index = trailIndex++ % trailCount;
  const position = dustGeometry.getAttribute('position');
  position.setXYZ(index, (pointer.x / width - .5) * span.x, (.5 - pointer.y / height) * span.y, 0);
  position.needsUpdate = true;
  const births = dustGeometry.getAttribute('aBirth');
  births.setX(index, elapsed);
  births.needsUpdate = true;
  lastTrail = now; lastTrailX = pointer.x; lastTrailY = pointer.y;
}
function tick(now) {
  frame = 0;
  if (document.hidden || isStatic() || lost) return;
  if (lastFrame && now - lastFrame < 31) { schedule(); return; }
  const dt = lastFrame ? Math.min(now - lastFrame, 64) : 33;
  lastFrame = now;
  elapsed += dt / 1000;
  uniforms.uTime.value = elapsed;
  follow(dt);
  render();
  schedule();
}
function resize() {
  width = innerWidth; height = innerHeight;
  resizeRenderer();
  clearDust();
  render();
}
window.addEventListener('pointermove', event => {
  if (isStatic() || event.pointerType === 'touch') return;
  pointer.x = event.clientX; pointer.y = event.clientY;
  if (!pointer.active) {
    pointer.ringX = pointer.fieldX = pointer.x;
    pointer.ringY = pointer.fieldY = pointer.y;
    lastTrailX = pointer.x; lastTrailY = pointer.y;
  }
  pointer.active = true;
  pointer.hover = !!event.target.closest('a, button, input, textarea, select, summary');
  addDust(performance.now());
  schedule();
}, { passive: true });
window.addEventListener('pointerdown', event => {
  if (isStatic() || event.pointerType === 'touch') return;
  pointer.down = true; schedule();
}, { passive: true });
window.addEventListener('pointerup', () => { pointer.down = false; schedule(); }, { passive: true });
const leave = () => { pointer.active = false; pointer.down = false; schedule(); };
document.documentElement.addEventListener('pointerleave', leave);
window.addEventListener('blur', leave);
window.addEventListener('resize', resize, { passive: true });
document.addEventListener('visibilitychange', () => {
  document.documentElement.dataset.effectsPaused = String(document.hidden);
  if (document.hidden) stop(); else schedule();
});
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault(); lost = true; stop();
  document.documentElement.dataset.webgl = 'fallback';
});
canvas.addEventListener('webglcontextrestored', () => {
  lost = false;
  document.documentElement.dataset.webgl = 'ready';
  clearDust(); render(); schedule();
});
new MutationObserver(updatePalette).observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
reducedMotion.addEventListener('change', updatePreferences);
finePointer.addEventListener('change', updatePreferences);
window.addEventListener('pagehide', () => stop());
window.addEventListener('pageshow', () => schedule());
// Previous comparison URLs now open this single star field.
const url = new URL(location.href);
if (url.searchParams.has('effect')) {
  url.searchParams.delete('effect'); history.replaceState(null, '', url);
}
updatePreferences();
