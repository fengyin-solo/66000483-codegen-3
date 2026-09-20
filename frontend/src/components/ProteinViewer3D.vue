<template>
  <div class="panel">
    <h3>🔬 3D蛋白骨架 (Cα原子轨迹)</h3>
    <div class="viewer-row">
      <div ref="container" class="viewer3d"></div>
      <aside class="annotation-panel">
        <div class="annotation-head">
          <span class="annotation-title">⚠️ 高能残基标注</span>
          <label class="top-count">
            展示数量
            <input type="number" v-model.number="topCount" />
          </label>
        </div>
        <p v-if="!store.selectedConformation" class="annotation-note">
          尚未选择构象：点击 Ramachandran 图或表格中的构象后，这里会列出该构象中能量最高的残基，并在骨架上标出。
        </p>
        <p v-else-if="countOutOfRange" class="annotation-note">
          展示数量「{{ topCount === '' ? '空' : topCount }}」超出有效范围（1–{{ residuesCount }}），无法生成标注，请调整后再试。
        </p>
        <template v-else>
          <ul class="annotation-list">
            <li
              v-for="item in topResidues"
              :key="item.index"
              :class="{ active: item.index === focusedIndex }"
              @click="toggleFocus(item.index)"
            >
              <span class="marker-icon" :class="`shape-${item.shape}`" :style="{ '--marker-color': item.color }"></span>
              <span class="res-num">残基 #{{ item.index }}</span>
              <span class="res-angles">φ={{ item.phi.toFixed(1) }}° ψ={{ item.psi.toFixed(1) }}°</span>
              <span class="res-energy">{{ item.energy.toFixed(3) }} kcal/mol</span>
            </li>
          </ul>
          <p class="annotation-hint">点击列表项将镜头对准该残基，再次点击取消跟随。</p>
        </template>
      </aside>
    </div>
    <p class="info" v-if="store.selectedConformation">
      当前: φ={{ store.selectedConformation.phi.toFixed(1) }}° ψ={{ store.selectedConformation.psi.toFixed(1) }}° 能量={{ store.selectedConformation.energy.toFixed(2) }} kcal/mol
    </p>
    <p class="info" v-else>点击Ramachandran图或表格中的构象以查看3D骨架</p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useProteinStore } from '../store/protein'

interface ResidueAnnotation {
  index: number   // 残基编号（从1开始）
  phi: number
  psi: number
  energy: number
  shape: string
  color: string
}

const store = useProteinStore()
const container = ref<HTMLDivElement>()
let scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer
let controls: OrbitControls, animationId: number
let backboneGroup = new THREE.Group()
const annotationGroup = new THREE.Group()
let caPositions: THREE.Vector3[] = []

// 标注视图状态（输入框清空时 v-model.number 会得到空字符串，故联合类型）
const topCount = ref<number | string>(5)
const focusedIndex = ref<number | null>(null)

// 每个名次对应一种标记形态与颜色，3D标记与列表图标共用
const MARKER_SHAPES = ['sphere', 'octahedron', 'box', 'tetrahedron', 'cone']
const MARKER_COLORS = ['#ff4757', '#ffa502', '#2ed573', '#1e90ff', '#eccc68', '#a55eea', '#ff6b81', '#7bed9f']

const residuesCount = computed(() => store.result?.params.residues || 8)
const topCountNum = computed(() => Number(topCount.value))
const countOutOfRange = computed(() => {
  const n = topCountNum.value
  return !Number.isFinite(n) || n < 1 || n > residuesCount.value
})

// 与后端一致的 LJ 势能公式
function ljEnergy(phi: number, psi: number): number {
  const sigma = 3.4, epsilon = 0.5
  let r = Math.sqrt(phi * phi + psi * psi) / 180 * 3 + 2
  r = Math.max(r, 1)
  const ratio = sigma / r
  return 4 * epsilon * (Math.pow(ratio, 12) - Math.pow(ratio, 6)) + epsilon
}

// 确定性伪随机数（仅取决于残基编号），保证同一构象每次渲染结果一致
function hash01(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

function wrapAngle(a: number): number {
  return ((a + 180) % 360 + 360) % 360 - 180
}

// 由构象整体 φ/ψ 派生各残基的二面角（小幅确定性微扰）
function residueAngles(phi0: number, psi0: number, index: number) {
  return {
    phi: wrapAngle(phi0 + (hash01(index * 2 + 1) - 0.5) * 50),
    psi: wrapAngle(psi0 + (hash01(index * 2 + 2) - 0.5) * 50),
  }
}

// 能量最高的前 N 个残基；能量按 0.001 分桶，接近者按编号升序稳定排列
const topResidues = computed<ResidueAnnotation[]>(() => {
  const conf = store.selectedConformation
  if (!conf || countOutOfRange.value) return []
  const all: Omit<ResidueAnnotation, 'shape' | 'color'>[] = []
  for (let i = 1; i <= residuesCount.value; i++) {
    const { phi, psi } = residueAngles(conf.phi, conf.psi, i)
    all.push({ index: i, phi, psi, energy: ljEnergy(phi, psi) })
  }
  all.sort((a, b) => {
    const ea = Math.round(a.energy * 1000), eb = Math.round(b.energy * 1000)
    if (eb !== ea) return eb - ea
    return a.index - b.index
  })
  return all.slice(0, topCountNum.value).map((item, rank) => ({
    ...item,
    shape: MARKER_SHAPES[rank % MARKER_SHAPES.length],
    color: MARKER_COLORS[rank % MARKER_COLORS.length],
  }))
})

function initScene() {
  if (!container.value) return
  const w = container.value.clientWidth, h = container.value.clientHeight

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x1a1a2e)
  scene.fog = new THREE.Fog(0x1a1a2e, 5, 20)

  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100)
  camera.position.set(3, 2, 6)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(w, h)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  container.value.appendChild(renderer.domElement)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.1

  scene.add(new THREE.AmbientLight(0x404060, 1.5))
  const dl = new THREE.DirectionalLight(0xffffff, 1.2)
  dl.position.set(5, 5, 5)
  scene.add(dl)
  const dl2 = new THREE.DirectionalLight(0x6688cc, 0.6)
  dl2.position.set(-3, -2, -5)
  scene.add(dl2)

  const grid = new THREE.GridHelper(8, 20, 0x444466, 0x222244)
  scene.add(grid)

  scene.add(backboneGroup)
}

function makeMarkerGeometry(shape: string): THREE.BufferGeometry {
  switch (shape) {
    case 'octahedron': return new THREE.OctahedronGeometry(0.2)
    case 'box': return new THREE.BoxGeometry(0.28, 0.28, 0.28)
    case 'tetrahedron': return new THREE.TetrahedronGeometry(0.23)
    case 'cone': return new THREE.ConeGeometry(0.17, 0.32, 12)
    default: return new THREE.SphereGeometry(0.17, 16, 16)
  }
}

// 用 canvas 生成带残基编号的标签精灵
function makeLabelSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.roundRect(2, 2, 124, 60, 14)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 30px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 64, 34)
  const texture = new THREE.CanvasTexture(canvas)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }))
  sprite.scale.set(0.9, 0.45, 1)
  sprite.renderOrder = 999
  return sprite
}

// 清空上一批标注并释放显存资源，避免残留
function clearAnnotations() {
  annotationGroup.traverse((obj) => {
    const anyObj = obj as any
    if (anyObj.geometry) anyObj.geometry.dispose()
    if (anyObj.material) {
      if (anyObj.material.map) anyObj.material.map.dispose()
      anyObj.material.dispose()
    }
  })
  annotationGroup.clear()
}

// 按当前清单在骨架上重建标注（标记 + 编号标签 + 引线）
function updateAnnotations() {
  clearAnnotations()
  for (const item of topResidues.value) {
    const p = caPositions[item.index - 1]
    if (!p) continue
    const color = new THREE.Color(item.color)

    const marker = new THREE.Mesh(
      makeMarkerGeometry(item.shape),
      new THREE.MeshPhongMaterial({ color, emissive: color.clone().multiplyScalar(0.35) })
    )
    marker.position.copy(p).add(new THREE.Vector3(0, 0.55, 0))
    annotationGroup.add(marker)

    const lineGeom = new THREE.BufferGeometry().setFromPoints([p, p.clone().add(new THREE.Vector3(0, 0.55, 0))])
    annotationGroup.add(new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color })))

    const sprite = makeLabelSprite(`#${item.index}`, item.color)
    sprite.position.copy(p).add(new THREE.Vector3(0, 1.05, 0))
    annotationGroup.add(sprite)
  }
}

function buildBackbone(phi: number, psi: number) {
  backboneGroup.clear()
  clearAnnotations()
  backboneGroup.add(annotationGroup)
  const bondLen = 1.47
  const angle = 109.5 * Math.PI / 180

  let pos = new THREE.Vector3(0, 0, 0)
  let dir = new THREE.Vector3(1, 0, 0)

  const caMat = new THREE.MeshPhongMaterial({ color: 0x44aaff, emissive: 0x112244 })
  const nMat = new THREE.MeshPhongMaterial({ color: 0x3355cc, emissive: 0x111133 })
  const cMat = new THREE.MeshPhongMaterial({ color: 0xff6644, emissive: 0x331111 })
  const bondMat = new THREE.MeshPhongMaterial({ color: 0xaaaaaa })

  const residues = store.result?.params.residues || 8
  caPositions = []

  for (let i = 0; i < residues; i++) {
    const nPos = pos.clone()
    const nSphere = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 16), nMat)
    nSphere.position.copy(nPos)
    backboneGroup.add(nSphere)

    const caPos = nPos.clone().add(dir.clone().multiplyScalar(0.49))
    const caSphere = new THREE.Mesh(new THREE.SphereGeometry(0.30, 16, 16), caMat)
    caSphere.position.copy(caPos)
    backboneGroup.add(caSphere)
    caPositions.push(caPos.clone())

    const cPos = caPos.clone().add(dir.clone().multiplyScalar(0.53))
    const cSphere = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 16), cMat)
    cSphere.position.copy(cPos)
    backboneGroup.add(cSphere)

    for (const [a, b] of [[nPos, caPos], [caPos, cPos]] as [THREE.Vector3, THREE.Vector3][]) {
      const mid = a.clone().add(b).multiplyScalar(0.5)
      const dist = a.distanceTo(b)
      const bondGeom = new THREE.CylinderGeometry(0.07, 0.07, dist, 8)
      const bond = new THREE.Mesh(bondGeom, bondMat)
      bond.position.copy(mid)
      const bLocal = b.clone().sub(a).normalize()
      bond.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), bLocal)
      backboneGroup.add(bond)
    }

    const nextDir = dir.clone()
    nextDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle - Math.PI / 2)
    nextDir.applyAxisAngle(dir, psi * Math.PI / 180)
    pos = cPos.clone().add(nextDir.clone().multiplyScalar(0.49))
    dir = nextDir
  }

  const box = new THREE.Box3().setFromObject(backboneGroup)
  const center = new THREE.Vector3()
  box.getCenter(center)
  backboneGroup.position.sub(center)

  updateAnnotations()
}

// 把镜头对准指定残基的当前世界位置
function focusResidue(index: number) {
  const p = caPositions[index - 1]
  if (!p || !camera || !controls) return
  focusedIndex.value = index
  backboneGroup.updateMatrixWorld(true)
  const world = backboneGroup.localToWorld(p.clone())
  const dir = camera.position.clone().sub(controls.target)
  if (dir.lengthSq() < 1e-6) dir.set(1, 1, 1)
  dir.normalize()
  controls.target.copy(world)
  camera.position.copy(world.clone().add(dir.multiplyScalar(3.2)))
}

function toggleFocus(index: number) {
  if (focusedIndex.value === index) {
    focusedIndex.value = null
    return
  }
  focusResidue(index)
}

function animate() {
  animationId = requestAnimationFrame(animate)
  // 聚焦期间让镜头跟随该残基（骨架在自动转动），用户仍可正常旋转缩放
  if (focusedIndex.value != null) {
    const p = caPositions[focusedIndex.value - 1]
    if (p) {
      backboneGroup.updateMatrixWorld(true)
      const world = backboneGroup.localToWorld(p.clone())
      const delta = world.clone().sub(controls.target)
      controls.target.copy(world)
      camera.position.add(delta)
    }
  }
  controls.update()
  backboneGroup.rotation.y += 0.001
  renderer.render(scene, camera)
}

function onResize() {
  if (!container.value) return
  renderer.setSize(container.value.clientWidth, container.value.clientHeight)
  camera.aspect = container.value.clientWidth / container.value.clientHeight
  camera.updateProjectionMatrix()
}

onMounted(() => {
  initScene()
  buildBackbone(-60, -45)
  animate()
  window.addEventListener('resize', onResize)
})

watch(() => store.selectedConformation, (conf) => {
  focusedIndex.value = null
  if (conf) buildBackbone(conf.phi, conf.psi)
  else clearAnnotations()
})

// 清单（构象/展示数量）变化时同步重建标注，保证二者一致
watch(topResidues, () => updateAnnotations())

onUnmounted(() => {
  cancelAnimationFrame(animationId)
  window.removeEventListener('resize', onResize)
  clearAnnotations()
  renderer?.dispose()
})
</script>

<style scoped>
.panel { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
.panel h3 { margin-bottom: 12px; color: #333; }
.viewer-row { display: flex; gap: 12px; align-items: stretch; }
.viewer3d { flex: 1; min-width: 0; height: 380px; border-radius: 8px; overflow: hidden; border: 1px solid #eee; }
.info { text-align: center; margin-top: 10px; font-size: 13px; color: #666; }

.annotation-panel { width: 250px; flex: none; display: flex; flex-direction: column; border: 1px solid #eee; border-radius: 8px; padding: 10px; max-height: 380px; overflow-y: auto; background: #fafbff; }
.annotation-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.annotation-title { font-size: 13px; font-weight: 600; color: #333; }
.top-count { font-size: 12px; color: #666; display: flex; align-items: center; gap: 4px; }
.top-count input { width: 52px; padding: 2px 4px; border: 1px solid #ccc; border-radius: 4px; font-size: 12px; }
.annotation-note { font-size: 12px; color: #888; line-height: 1.6; padding: 8px 4px; }
.annotation-hint { font-size: 11px; color: #aaa; margin-top: 8px; }
.annotation-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
.annotation-list li { display: grid; grid-template-columns: 16px 1fr; grid-template-rows: auto auto auto; column-gap: 8px; align-items: center; padding: 6px 8px; border: 1px solid #e4e7f0; border-radius: 6px; background: #fff; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
.annotation-list li:hover { border-color: #667eea; }
.annotation-list li.active { border-color: #667eea; box-shadow: 0 0 0 2px rgba(102,126,234,.25); }
.marker-icon { grid-row: 1 / 4; width: 14px; height: 14px; background: var(--marker-color); justify-self: center; }
.shape-sphere { border-radius: 50%; }
.shape-octahedron { transform: rotate(45deg); border-radius: 2px; }
.shape-box { border-radius: 2px; }
.shape-tetrahedron { clip-path: polygon(50% 0, 100% 100%, 0 100%); }
.shape-cone { clip-path: polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0 50%); }
.res-num { font-size: 12px; font-weight: 600; color: #333; }
.res-angles { font-size: 11px; color: #777; }
.res-energy { font-size: 11px; color: #c0392b; font-weight: 600; }
</style>
