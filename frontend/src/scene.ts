import * as THREE from 'three'

/** Soft rim-glow around the planet. */
export function makeAtmosphere(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: { glowColor: { value: new THREE.Color('#5d8fdc') } },
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 glowColor;
      varying vec3 vNormal;
      void main() {
        float intensity = pow(max(0.62 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0), 3.0);
        gl_FragColor = vec4(glowColor, 1.0) * intensity;
      }
    `,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  })
  return new THREE.Mesh(new THREE.SphereGeometry(1.18, 48, 48), material)
}

export function makeStars(): THREE.Points {
  const count = 2200
  const positions = new Float32Array(count * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < count; i++) {
    v.randomDirection().multiplyScalar(24 + Math.random() * 10)
    positions[i * 3] = v.x
    positions[i * 3 + 1] = v.y
    positions[i * 3 + 2] = v.z
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const material = new THREE.PointsMaterial({
    color: '#c3cdea',
    size: 0.07,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
  })
  return new THREE.Points(geometry, material)
}

export function addLights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight('#fdf6e3', '#2e3b32', 0.9))
  const sun = new THREE.DirectionalLight('#fff2d0', 1.6)
  sun.position.set(3, 2, 1.5)
  scene.add(sun)
  scene.add(new THREE.AmbientLight('#ffffff', 0.25))
}
