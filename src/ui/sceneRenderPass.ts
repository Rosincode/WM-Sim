import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

/**
 * Tekent de scène met kantafvlakking (MSAA) in een eigen buffer en kopieert het resultaat naar de composer.
 * Zo hoeven de buffers van de composer zelf geen MSAA te hebben: anders moet de videokaart na elke
 * nabewerkingsstap (omgevingsschaduw, gloed) het hele beeld opnieuw samenvoegen, en dat is duur.
 */
export class SceneRenderPass extends Pass {
  private target: THREE.WebGLRenderTarget;
  private copy: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private scene: THREE.Scene;
  private camera: THREE.Camera;

  constructor(scene: THREE.Scene, camera: THREE.Camera, samples: number) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false; // het resultaat staat in de leesbuffer, net als bij RenderPass
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    this.copy = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.copy);
  }

  setSize(width: number, height: number) {
    this.target.setSize(width, height);
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    this.copy.uniforms.tDiffuse.value = this.target.texture;
    renderer.setRenderTarget(readBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.target.dispose();
    this.copy.dispose();
    this.quad.dispose();
  }
}
