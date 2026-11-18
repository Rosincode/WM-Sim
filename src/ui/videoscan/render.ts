import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildKoelhuis } from './koelhuis';
import { SHOTS } from './shots';

// Renderpagina voor de videoscan-test: http://localhost:5173/?videoscan[&shot=F09a]
// Bouwt het koelhuis uit de rondleidingsvideo na en zet de camera op het standpunt van de filmer.
// Het opnamescript (capture.mjs) roept window.videoscan.show(id) aan en maakt een schermafbeelding.

export function startVideoscan(params: URLSearchParams) {
  const size = { w: Number(params.get('w')) || 1280, h: Number(params.get('h')) || 720 };
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size.w, size.h);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  document.body.style.margin = '0';
  // de knoppen en panelen van het spel horen niet in beeld
  const css = document.createElement('style');
  css.textContent = 'body > :not(#app) { display: none !important; }';
  document.head.appendChild(css);
  document.querySelector<HTMLDivElement>('#app')!.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;
  const hemi = new THREE.HemisphereLight('#eef3ff', '#77746e', 0.34);
  scene.add(hemi);
  const key = new THREE.DirectionalLight('#fff6ea', 0.9);
  key.position.set(8, 60, 14);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  Object.assign(key.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 5, far: 130 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  scene.add(key);

  const { actors, handheld } = buildKoelhuis(scene);
  const camera = new THREE.PerspectiveCamera(55, size.w / size.h, 0.02, 600);
  scene.add(camera);
  camera.add(handheld);
  handheld.position.set(0.09, -0.07, -0.3);
  handheld.rotation.set(0.25, -0.15, 0.05);

  const INSIDE = new THREE.Color('#c3c8cb');
  const NIGHT = new THREE.Color('#1d2738');
  function show(id: string) {
    const shot = SHOTS.find((s) => s.id === id) ?? SHOTS[0];
    for (const a of actors) a.obj.visible = a.only.includes(shot.fragment);
    handheld.visible = !!shot.handheld;
    const env = shot.env ?? 'binnen';
    if (env === 'buiten') {
      scene.background = NIGHT;
      scene.fog = new THREE.Fog(NIGHT, 60, 220);
      hemi.intensity = 0.12;
      key.intensity = 0.08;
      scene.environmentIntensity = 0.12;
    } else {
      scene.background = INSIDE;
      scene.fog = env === 'vries' ? new THREE.FogExp2('#d6dde3', 0.03) : new THREE.FogExp2(INSIDE, 0.006);
      hemi.intensity = env === 'vries' ? 0.42 : 0.34;
      key.intensity = 0.9;
      scene.environmentIntensity = 0.45;
    }
    camera.fov = shot.fov ?? 55;
    camera.position.set(...shot.pos);
    camera.lookAt(...shot.look);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    renderer.render(scene, camera);
    return { id: shot.id, fragment: shot.fragment, t: shot.t };
  }

  const api = { shots: SHOTS.map((s) => s.id), show, ready: true };
  (window as unknown as { videoscan: typeof api }).videoscan = api;
  show(params.get('shot') ?? SHOTS[0].id);
}
