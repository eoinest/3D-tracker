import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusKnotGeometry,
} from 'three'

import { mulberry32, paletteColor } from './shared'

/**
 * Procedural stand-ins so the model viewer has something to show before you
 * upload anything — and so the repo ships without binary assets.
 */
export const BUILT_IN_MODELS: {
  id: string
  name: string
  description: string
  build(): Object3D
}[] = [
  {
    id: 'torus-knot',
    name: 'Torus Knot',
    description: 'Self-occluding curves — the classic parallax test object.',
    build: torusKnot,
  },
  {
    id: 'gem-cluster',
    name: 'Gem Cluster',
    description: 'Faceted shapes at mixed depths, with hard specular highlights.',
    build: gemCluster,
  },
  {
    id: 'helix',
    name: 'Double Helix',
    description: 'A tall spiral. Depth ordering flips as you move around it.',
    build: helix,
  },
]

function torusKnot(): Object3D {
  return new Mesh(
    new TorusKnotGeometry(0.6, 0.19, 220, 40),
    new MeshStandardMaterial({ color: 0x4cc9f0, roughness: 0.18, metalness: 0.85 }),
  )
}

function gemCluster(): Object3D {
  const group = new Group()
  const rand = mulberry32(0x1337)
  for (let i = 0; i < 11; i++) {
    const mesh = new Mesh(
      new IcosahedronGeometry(0.16 + rand() * 0.22, 0),
      new MeshStandardMaterial({
        color: paletteColor(i),
        roughness: 0.08 + rand() * 0.2,
        metalness: 0.5 + rand() * 0.5,
        flatShading: true,
      }),
    )
    mesh.position.set((rand() - 0.5) * 1.1, (rand() - 0.5) * 1.1, (rand() - 0.5) * 1.1)
    mesh.rotation.set(rand() * 3, rand() * 3, rand() * 3)
    group.add(mesh)
  }
  return group
}

function helix(): Object3D {
  const group = new Group()
  const beadGeometry = new SphereGeometry(0.07, 20, 14)
  const rungGeometry = new CylinderGeometry(0.016, 0.016, 1, 12)
  const spineGeometry = new BoxGeometry(0.03, 0.03, 0.03)

  const turns = 3
  const steps = 60
  const radius = 0.34
  const height = 1.6

  const matA = new MeshStandardMaterial({ color: 0x4cc9f0, roughness: 0.25, metalness: 0.4 })
  const matB = new MeshStandardMaterial({ color: 0xf72585, roughness: 0.25, metalness: 0.4 })
  const matRung = new MeshStandardMaterial({ color: 0xdfe7f5, roughness: 0.5, metalness: 0.2 })

  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const angle = t * turns * Math.PI * 2
    const y = (t - 0.5) * height
    const ax = Math.cos(angle) * radius
    const az = Math.sin(angle) * radius

    const a = new Mesh(beadGeometry, matA)
    a.position.set(ax, y, az)
    const b = new Mesh(beadGeometry, matB)
    b.position.set(-ax, y, -az)
    group.add(a, b)

    if (i % 4 === 0) {
      const rung = new Mesh(rungGeometry, matRung)
      rung.scale.y = radius * 2
      rung.position.set(0, y, 0)
      rung.rotation.z = Math.PI / 2
      rung.rotation.y = -angle
      group.add(rung)

      const pip = new Mesh(spineGeometry, matRung)
      pip.position.set(ax * 1.25, y, az * 1.25)
      group.add(pip)
    }
  }
  return group
}
