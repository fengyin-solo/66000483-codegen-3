<template>
  <div class="panel">
    <h3>🔬 3D蛋白骨架 (Cα原子轨迹)</h3>
    <div ref="container" class="viewer3d">
      <div class="annot-toolbar">
        <span class="annot-title">🏷️ 高能量残基标注</span>
        <span class="annot-count">
          显示前
          <el-input-number
            v-model="showCount"
            :min="1"
            :max="residueCount"
            :disabled="!store.selectedConformation"
            size="small"
            controls-position="right"
            class="count-input"
          />
          个 / 共 {{ residueCount }} 残基
        </span>
      </div>

      <div class="annot-panel" v-if="store.selectedConformation && countValid">
        <div
          v-for="(r, rank) in topResidues"
          :key="r.index"
          class="annot-item"
          :class="{ active: selectedResidue === r.index }"
          @click="focusResidue(r.index)"
        >
          <span class="rank-badge" :class="'shape-' + Math.min(rank, 2)" :style="{ background: rankCssColor(rank) }">
            {{ r.index }}
          </span>
          <div class="annot-body">
            <div class="chips">
              <span class="chip phi">φ {{ fmtAngle(r.phi) }}°</span>
              <span class="chip psi">ψ {{ fmtAngle(r.psi) }}°</span>
            </div>
            <div class="energy-row">
              <div class="track"><div class="fill" :style="{ width: energyPct(r.energy) + '%', background: rankCssColor(rank) }"></div></div>
              <span class="eval">{{ r.energy.toFixed(2) }}</span>
            </div>
          </div>
        </div>
        <p class="annot-hint">点击任一条目，镜头将对准该残基</p>
      </div>

      <div class="annot-empty" v-else>
        {{ emptyMessage }}
      </div>
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
import type { Conformation } from '../types'

interface ResidueData {
  index: number          // 1-based 残基编号
  phi: number            // 该残基自己的 φ 二面角
  psi: number            // 该残基自己的 ψ 二面角
  energy: number         // 该残基的 LJ 能量
  caLocal: THREE.Vector3 // Cα 在骨架局部坐标系中的位置
}

// 排名越高（能量越大）颜色越醒目；超出色板后用中性灰
const RANK_COLORS = [0xff4d4f, 0xfa8c16, 0xffc53d, 0x7bd66a, 0x36cfc9]
const RANK_CSS = ['#ff4d4f', '#fa8c16', '#ffc53d', '#7bd66a', '#36cfc9']
const FALLBACK_COLOR = 0x9fb3c8
const FALLBACK_CSS = '#9fb3c8'

// 能量差在该阈值（kcal/mol）以内视为“接近”，按编号先后稳定排列
const ENERGY_TIE_STEP = 0.01

const store = useProteinStore()
const container = ref<HTMLDivElement>()
let scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer
let controls: OrbitControls, animationId: number
// backboneRoot 负责既有的自动转动；其下骨架与标注两个分组共享同一个居中偏移，始终对齐
const backboneRoot = new THREE.Group()
const backboneGroup = new THREE.Group()
const annotationGroup = new THREE.Group()

const showCount = ref(5)
const selectedResidue = ref(-1)
const residueData = ref<ResidueData[]>([])
// 编号 -> 标注光晕，用于选中残基的呼吸高亮（非响应式的 three 对象）
let haloByIndex = new Map<number, THREE.Sprite>()
// 编号 -> Cα 局部坐标
const residueCaPos = new Map<number, THREE.Vector3>()

// 镜头聚焦动画状态：offset 是相对目标残基的世界空间偏移，锁定后随残基一起运动
let focusActive = false
const focusOffset = new THREE.Vector3(0, 0, 2.4)
const clock = new THREE.Clock()

const residueCount = computed(() => residueData.value.length)

const countValid = computed(() =>
  Number.isInteger(showCount.value) &&
  showCount.value >= 1 &&
  showCount.value <= residueData.value.length
)

// 能量最高的若干残基：能量降序；量化到 0.01 后相等（能量接近）的按编号升序，保证稳定
const topResidues = computed<ResidueData[]>(() => {
  const all = residueData.value
  if (!store.selectedConformation || !countValid.value) return []
  return [...all]
    .map(r => ({ r, bucket: Math.round(r.energy / ENERGY_TIE_STEP) }))
    .sort((a, b) => (b.bucket - a.bucket) || (a.r.index - b.r.index))
    .slice(0, showCount.value)
    .map(x => x.r)
})

// 构象为空或数量越界时，在侧栏位置给出文字说明，而不是留空白
const emptyMessage = computed(() => {
  if (!store.selectedConformation) {
    return '构象为空：请先在上方生成构象采样，并在 Ramachandran 图或构象表格中点选一个构象，这里将逐条列出能量最高的残基。'
  }
  const n = residueData.value.length
  const k = showCount.value
  if (!Number.isFinite(k) || k < 1 || k > n) {
    return `展示数量超出范围：当前构象共 ${n} 个残基，无法列出 ${k} 个；请把数量调整到 1～${n}。`
  }
  return ''
})

function rankColor(rank: number): THREE.ColorRepresentation {
  return RANK_COLORS[rank] ?? FALLBACK_COLOR
}
function rankCssColor(rank: number): string {
  return RANK_CSS[rank] ?? FALLBACK_CSS
}
function fmtAngle(a: number): string {
  return (a > 0 && a !== 0 ? '+' : '') + a.toFixed(1)
}

function energyPct(e: number): number {
  const es = residueData.value.map(r => r.energy)
  const lo = Math.min(...es), hi = Math.max(...es)
  return Math.round(((e - lo) / (hi - lo || 1)) * 100)
}

/* ---------------- 确定性的逐残基数据（同一构象每次结果一致） ---------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(rng: () => number): number {
  // Box–Muller
  return Math.sqrt(-2 * Math.log(rng() || 1e-9)) * Math.cos(2 * Math.PI * rng())
}

function wrap180(a: number): number {
  return ((a + 180) % 360 + 360) % 360 - 180
}

// 与后端一致的 LJ 势能（kcal/mol）
function ljEnergy(phi: number, psi: number): number {
  const r = Math.max(Math.hypot(phi, psi) / 180 * 3 + 2, 1)
  const ratio = 3.4 / r
  return 4 * 0.5 * (ratio ** 12 - ratio ** 6) + 0.5
}

function generateResidues(conf: Conformation | null): ResidueData[] {
  const count = store.result?.params.residues ?? 8
  const basePhi = conf ? conf.phi : -60
  const basePsi = conf ? conf.psi : -45
  // 用构象编号做种子：切换构象时整组数据一起换新，且同一构象反复点选结果不变
  const rng = mulberry32((conf ? conf.id : 0) * 2654435761 + 1)
  const out: ResidueData[] = []
  for (let i = 0; i < count; i++) {
    const phi = wrap180(basePhi + (rng() - 0.5) * 50 + gaussian(rng) * 8)
    const psi = wrap180(basePsi + (rng() - 0.5) * 50 + gaussian(rng) * 8)
    const energy = Math.round((ljEnergy(phi, psi) + gaussian(rng) * 0.04) * 1000) / 1000
    out.push({ index: i + 1, phi, psi, energy, caLocal: new THREE.Vector3() })
  }
  return out
}

/* ---------------- three.js 场景 ---------------- */

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

  // 旋转 / 缩放 / 阻尼设置与此前完全一致，不做改动
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

  backboneRoot.add(backboneGroup)
  backboneRoot.add(annotationGroup)
  scene.add(backboneRoot)

  // 用户一旦手动操作视角（旋转/缩放/平移），立即解除镜头锁定，避免与自动追踪打架
  renderer.domElement.addEventListener('pointerdown', onUserInteract)
}

function disposeObject(root: THREE.Object3D) {
  const trash: { dispose(): void }[] = []
  root.traverse(obj => {
    // Sprite 内部复用一份共享几何体，绝不能释放
    if (obj.type !== 'Sprite') {
      const withGeom = obj as THREE.Mesh
      if (withGeom.geometry) trash.push(withGeom.geometry)
    }
    const mat = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) mat.forEach(x => trash.push(x))
    else if (mat) trash.push(mat)
    const spriteMat = (obj as THREE.Sprite).material as THREE.SpriteMaterial | undefined
    if (spriteMat?.map) trash.push(spriteMat.map)
  })
  trash.forEach(d => d.dispose())
}

function clearGroup(group: THREE.Group) {
  disposeObject(group)
  group.clear()
}

function buildBackbone(residues: ResidueData[]) {
  clearGroup(backboneGroup)
  residueCaPos.clear()
  backboneGroup.position.set(0, 0, 0)
  annotationGroup.position.set(0, 0, 0)

  const angle = 109.5 * Math.PI / 180

  let pos = new THREE.Vector3(0, 0, 0)
  let dir = new THREE.Vector3(1, 0, 0)
  const yAxis = new THREE.Vector3(0, 1, 0)

  const caMat = new THREE.MeshPhongMaterial({ color: 0x44aaff, emissive: 0x112244 })
  const nMat = new THREE.MeshPhongMaterial({ color: 0x3355cc, emissive: 0x111133 })
  const cMat = new THREE.MeshPhongMaterial({ color: 0xff6644, emissive: 0x331111 })
  const bondMat = new THREE.MeshPhongMaterial({ color: 0xaaaaaa })

  for (let i = 0; i < residues.length; i++) {
    const nPos = pos.clone()
    const nSphere = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 16), nMat)
    nSphere.position.copy(nPos)
    backboneGroup.add(nSphere)

    const caPos = nPos.clone().add(dir.clone().multiplyScalar(0.49))
    const caSphere = new THREE.Mesh(new THREE.SphereGeometry(0.30, 16, 16), caMat)
    caSphere.position.copy(caPos)
    backboneGroup.add(caSphere)

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

    residues[i].caLocal.copy(caPos)
    residueCaPos.set(residues[i].index, caPos.clone())

    // 逐残基按自己的 φ/ψ 折叠；ψ 的处理沿用原有逻辑，φ 绕世界 Y 轴影响弯曲方向
    const nextDir = dir.clone()
    nextDir.applyAxisAngle(yAxis, angle - Math.PI / 2 + residues[i].phi * Math.PI / 180 * 0.6)
    nextDir.applyAxisAngle(dir, residues[i].psi * Math.PI / 180)
    pos = cPos.clone().add(nextDir.clone().multiplyScalar(0.49))
    dir = nextDir
  }

  // 两个分组使用同一居中偏移，标注与球棍始终重合，且自动转动绕几何中心进行
  const box = new THREE.Box3().setFromObject(backboneGroup)
  const center = new THREE.Vector3()
  box.getCenter(center)
  backboneGroup.position.copy(center).negate()
  annotationGroup.position.copy(center).negate()
}

/* ---------------- 骨架上的 3D 标注 ---------------- */

function makeHaloTexture(hex: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 128; canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const color = '#' + hex.toString(16).padStart(6, '0')
  const grad = ctx.createRadialGradient(64, 64, 20, 64, 64, 62)
  grad.addColorStop(0, 'rgba(0,0,0,0)')
  grad.addColorStop(0.62, color + '55')
  grad.addColorStop(0.9, color + 'cc')
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 128, 128)
  ctx.strokeStyle = color
  ctx.lineWidth = 7
  ctx.beginPath(); ctx.arc(64, 64, 48, 0, Math.PI * 2); ctx.stroke()
  return new THREE.CanvasTexture(canvas)
}

function makeLabelTexture(index: number, energy: number, hex: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 300; canvas.height = 110
  const ctx = canvas.getContext('2d')!
  const color = '#' + hex.toString(16).padStart(6, '0')

  ctx.beginPath()
  const r = 18
  ctx.moveTo(r, 4); ctx.lineTo(296 - r, 4); ctx.arcTo(296, 4, 296, r + 4, r)
  ctx.lineTo(296, 106 - r); ctx.arcTo(296, 106, 296 - r, 106, r)
  ctx.lineTo(r, 106); ctx.arcTo(4, 106, 4, 106 - r, r)
  ctx.lineTo(4, r + 4); ctx.arcTo(4, 4, r, 4, r); ctx.closePath()
  ctx.fillStyle = 'rgba(8,12,28,0.85)'
  ctx.fill()
  ctx.lineWidth = 5
  ctx.strokeStyle = color
  ctx.stroke()

  ctx.fillStyle = color
  ctx.font = 'bold 44px system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText(`#${index}`, 20, 38)
  ctx.fillStyle = '#e8ecff'
  ctx.font = '28px system-ui, sans-serif'
  ctx.fillText(`E ${energy.toFixed(2)} kcal/mol`, 20, 82)

  return new THREE.CanvasTexture(canvas)
}

function rebuildAnnotations() {
  // 每次整组重建：先移除并释放上一批的全部图形，杜绝残留
  clearGroup(annotationGroup)
  haloByIndex = new Map()

  const top = topResidues.value
  top.forEach((res, rank) => {
    const ca = res.caLocal
    const hex = rankColor(rank) as number

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeHaloTexture(hex), transparent: true, depthTest: false, depthWrite: false
    }))
    halo.position.copy(ca)
    halo.scale.set(0.9, 0.9, 1)
    halo.renderOrder = 10
    annotationGroup.add(halo)
    haloByIndex.set(res.index, halo)

    // 引线：Cα 到标签
    const labelPos = ca.clone().add(new THREE.Vector3(0, 0.62, 0.14))
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([ca, labelPos]),
      new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 0.7, depthTest: false })
    )
    line.renderOrder = 9
    annotationGroup.add(line)

    const label = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeLabelTexture(res.index, res.energy, hex),
      transparent: true, depthTest: false, depthWrite: false
    }))
    label.position.copy(labelPos)
    label.scale.set(1.5, 0.55, 1)
    label.renderOrder = 11
    annotationGroup.add(label)
  })
}

/* ---------------- 构象同步：骨架、3D标注、侧边清单一起更新 ---------------- */

function syncView(conf: Conformation | null) {
  focusActive = false
  selectedResidue.value = -1
  residueData.value = generateResidues(conf)
  buildBackbone(residueData.value)
  // topResidues 依赖新的 residueData/showCount，此刻已可直接取到最新结果
  rebuildAnnotations()
}

function focusResidue(index: number) {
  if (!residueCaPos.has(index)) return
  selectedResidue.value = index
  backboneRoot.updateWorldMatrix(true, false)
  const world = backboneGroup.localToWorld(residueCaPos.get(index)!.clone())

  // 保持当前观察方向与距离（夹到合理范围），锁定后镜头跟随该残基
  let dir = camera.position.clone().sub(controls.target)
  if (dir.lengthSq() < 1e-6) dir.set(1, 0.5, 1)
  const dist = THREE.MathUtils.clamp(dir.length(), 1.8, 3.2)
  focusOffset.copy(dir.normalize().multiplyScalar(dist))
  // 目标若恰好已在残基上，直接吸附，避免首帧抖动
  if (controls.target.distanceTo(world) < 1e-3) controls.target.copy(world)
  focusActive = true
}

function updateFocus() {
  if (!focusActive) return
  const local = residueCaPos.get(selectedResidue.value)
  if (!local) { focusActive = false; return }
  backboneRoot.updateWorldMatrix(true, false)
  const world = backboneGroup.localToWorld(local.clone())
  const desiredCam = world.clone().add(focusOffset)
  // 接近后直接吸附并持续锁定，自动转动时残基始终保持在画面中心
  if (controls.target.distanceTo(world) < 0.02) controls.target.copy(world)
  else controls.target.lerp(world, 0.2)
  if (camera.position.distanceTo(desiredCam) < 0.02) camera.position.copy(desiredCam)
  else camera.position.lerp(desiredCam, 0.12)
}

function onUserInteract() {
  focusActive = false
}

function animate() {
  animationId = requestAnimationFrame(animate)
  const t = clock.getElapsedTime()
  // 自动转动速度与此前完全一致
  backboneRoot.rotation.y += 0.001
  updateFocus()
  controls.update()
  const halo = haloByIndex.get(selectedResidue.value)
  if (halo) {
    const s = 0.95 + Math.sin(t * 5) * 0.13
    halo.scale.set(s, s, 1)
  }
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
  syncView(null)
  animate()
  window.addEventListener('resize', onResize)
})

watch(() => store.selectedConformation, (conf) => {
  syncView(conf)
})

watch(showCount, () => {
  // 只改数量时不动骨架，仅让清单与 3D 标注同步重建
  rebuildAnnotations()
})

onUnmounted(() => {
  cancelAnimationFrame(animationId)
  window.removeEventListener('resize', onResize)
  renderer?.domElement.removeEventListener('pointerdown', onUserInteract)
  clearGroup(backboneGroup)
  clearGroup(annotationGroup)
  renderer?.dispose()
})
</script>

<style scoped>
.panel { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
.panel h3 { margin-bottom: 12px; color: #333; }
.viewer3d { position: relative; width: 100%; height: 380px; border-radius: 8px; overflow: hidden; border: 1px solid #eee; }
.info { text-align: center; margin-top: 10px; font-size: 13px; color: #666; }

.annot-toolbar {
  position: absolute; top: 10px; left: 10px; z-index: 5;
  display: flex; flex-direction: column; gap: 6px;
  background: rgba(10,14,30,.72); border: 1px solid rgba(255,255,255,.12);
  border-radius: 8px; padding: 8px 10px; color: #e8ecff;
  font-size: 12px; backdrop-filter: blur(4px);
}
.annot-title { font-weight: 600; font-size: 13px; }
.annot-count { display: flex; align-items: center; gap: 4px; opacity: .9; }
.count-input { width: 108px; }

.annot-panel {
  position: absolute; top: 10px; right: 10px; z-index: 5;
  width: 230px; max-height: 340px; overflow-y: auto;
  background: rgba(10,14,30,.78); border: 1px solid rgba(255,255,255,.12);
  border-radius: 8px; padding: 8px; backdrop-filter: blur(4px);
  display: flex; flex-direction: column; gap: 6px;
}
.annot-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-radius: 6px; cursor: pointer;
  border: 1px solid transparent; transition: background .15s, border-color .15s;
}
.annot-item:hover { background: rgba(255,255,255,.08); }
.annot-item.active { background: rgba(120,150,255,.18); border-color: rgba(120,150,255,.6); }

.rank-badge {
  flex: none; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
  color: #10131f; font-weight: 700; font-size: 13px;
}
.rank-badge.shape-0 { border-radius: 50%; box-shadow: 0 0 8px rgba(255,77,79,.8); transform: scale(1.08); }
.rank-badge.shape-1 { border-radius: 8px; }
.rank-badge.shape-2 { border-radius: 3px; }

.annot-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.chips { display: flex; gap: 4px; }
.chip {
  font-size: 11px; padding: 1px 6px; border-radius: 10px; font-variant-numeric: tabular-nums;
}
.chip.phi { background: rgba(68,170,255,.22); color: #9bd1ff; }
.chip.psi { background: rgba(167,113,255,.22); color: #d3b3ff; }

.energy-row { display: flex; align-items: center; gap: 6px; }
.track { flex: 1; height: 6px; border-radius: 3px; background: rgba(255,255,255,.14); overflow: hidden; }
.fill { height: 100%; border-radius: 3px; transition: width .2s; }
.eval { font-size: 11px; color: #cdd6f4; font-variant-numeric: tabular-nums; min-width: 38px; text-align: right; }

.annot-hint { font-size: 11px; color: rgba(232,236,255,.55); text-align: center; padding: 2px 0 4px; }

.annot-empty {
  position: absolute; z-index: 5; left: 50%; top: 50%; transform: translate(-50%,-50%);
  width: 72%; max-height: 80%; overflow-y: auto;
  background: rgba(10,14,30,.72); border: 1px dashed rgba(255,255,255,.25);
  border-radius: 8px; padding: 14px;
  color: #d6ddff; font-size: 12.5px; line-height: 1.7; text-align: center;
}
</style>
