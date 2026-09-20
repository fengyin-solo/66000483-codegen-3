/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useProteinStore } from '../store/protein';
const store = useProteinStore();
const container = ref();
let scene, camera, renderer;
let controls, animationId;
let backboneGroup = new THREE.Group();
const annotationGroup = new THREE.Group();
let caPositions = [];
// 标注视图状态（输入框清空时 v-model.number 会得到空字符串，故联合类型）
const topCount = ref(5);
const focusedIndex = ref(null);
// 每个名次对应一种标记形态与颜色，3D标记与列表图标共用
const MARKER_SHAPES = ['sphere', 'octahedron', 'box', 'tetrahedron', 'cone'];
const MARKER_COLORS = ['#ff4757', '#ffa502', '#2ed573', '#1e90ff', '#eccc68', '#a55eea', '#ff6b81', '#7bed9f'];
const residuesCount = computed(() => store.result?.params.residues || 8);
const topCountNum = computed(() => Number(topCount.value));
const countOutOfRange = computed(() => {
    const n = topCountNum.value;
    return !Number.isFinite(n) || n < 1 || n > residuesCount.value;
});
// 与后端一致的 LJ 势能公式
function ljEnergy(phi, psi) {
    const sigma = 3.4, epsilon = 0.5;
    let r = Math.sqrt(phi * phi + psi * psi) / 180 * 3 + 2;
    r = Math.max(r, 1);
    const ratio = sigma / r;
    return 4 * epsilon * (Math.pow(ratio, 12) - Math.pow(ratio, 6)) + epsilon;
}
// 确定性伪随机数（仅取决于残基编号），保证同一构象每次渲染结果一致
function hash01(n) {
    const x = Math.sin(n * 12.9898) * 43758.5453;
    return x - Math.floor(x);
}
function wrapAngle(a) {
    return ((a + 180) % 360 + 360) % 360 - 180;
}
// 由构象整体 φ/ψ 派生各残基的二面角（小幅确定性微扰）
function residueAngles(phi0, psi0, index) {
    return {
        phi: wrapAngle(phi0 + (hash01(index * 2 + 1) - 0.5) * 50),
        psi: wrapAngle(psi0 + (hash01(index * 2 + 2) - 0.5) * 50),
    };
}
// 能量最高的前 N 个残基；能量按 0.001 分桶，接近者按编号升序稳定排列
const topResidues = computed(() => {
    const conf = store.selectedConformation;
    if (!conf || countOutOfRange.value)
        return [];
    const all = [];
    for (let i = 1; i <= residuesCount.value; i++) {
        const { phi, psi } = residueAngles(conf.phi, conf.psi, i);
        all.push({ index: i, phi, psi, energy: ljEnergy(phi, psi) });
    }
    all.sort((a, b) => {
        const ea = Math.round(a.energy * 1000), eb = Math.round(b.energy * 1000);
        if (eb !== ea)
            return eb - ea;
        return a.index - b.index;
    });
    return all.slice(0, topCountNum.value).map((item, rank) => ({
        ...item,
        shape: MARKER_SHAPES[rank % MARKER_SHAPES.length],
        color: MARKER_COLORS[rank % MARKER_COLORS.length],
    }));
});
function initScene() {
    if (!container.value)
        return;
    const w = container.value.clientWidth, h = container.value.clientHeight;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);
    scene.fog = new THREE.Fog(0x1a1a2e, 5, 20);
    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    camera.position.set(3, 2, 6);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.value.appendChild(renderer.domElement);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    scene.add(new THREE.AmbientLight(0x404060, 1.5));
    const dl = new THREE.DirectionalLight(0xffffff, 1.2);
    dl.position.set(5, 5, 5);
    scene.add(dl);
    const dl2 = new THREE.DirectionalLight(0x6688cc, 0.6);
    dl2.position.set(-3, -2, -5);
    scene.add(dl2);
    const grid = new THREE.GridHelper(8, 20, 0x444466, 0x222244);
    scene.add(grid);
    scene.add(backboneGroup);
}
function makeMarkerGeometry(shape) {
    switch (shape) {
        case 'octahedron': return new THREE.OctahedronGeometry(0.2);
        case 'box': return new THREE.BoxGeometry(0.28, 0.28, 0.28);
        case 'tetrahedron': return new THREE.TetrahedronGeometry(0.23);
        case 'cone': return new THREE.ConeGeometry(0.17, 0.32, 12);
        default: return new THREE.SphereGeometry(0.17, 16, 16);
    }
}
// 用 canvas 生成带残基编号的标签精灵
function makeLabelSprite(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(2, 2, 124, 60, 14);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 64, 34);
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
    sprite.scale.set(0.9, 0.45, 1);
    sprite.renderOrder = 999;
    return sprite;
}
// 清空上一批标注并释放显存资源，避免残留
function clearAnnotations() {
    annotationGroup.traverse((obj) => {
        const anyObj = obj;
        if (anyObj.geometry)
            anyObj.geometry.dispose();
        if (anyObj.material) {
            if (anyObj.material.map)
                anyObj.material.map.dispose();
            anyObj.material.dispose();
        }
    });
    annotationGroup.clear();
}
// 按当前清单在骨架上重建标注（标记 + 编号标签 + 引线）
function updateAnnotations() {
    clearAnnotations();
    for (const item of topResidues.value) {
        const p = caPositions[item.index - 1];
        if (!p)
            continue;
        const color = new THREE.Color(item.color);
        const marker = new THREE.Mesh(makeMarkerGeometry(item.shape), new THREE.MeshPhongMaterial({ color, emissive: color.clone().multiplyScalar(0.35) }));
        marker.position.copy(p).add(new THREE.Vector3(0, 0.55, 0));
        annotationGroup.add(marker);
        const lineGeom = new THREE.BufferGeometry().setFromPoints([p, p.clone().add(new THREE.Vector3(0, 0.55, 0))]);
        annotationGroup.add(new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color })));
        const sprite = makeLabelSprite(`#${item.index}`, item.color);
        sprite.position.copy(p).add(new THREE.Vector3(0, 1.05, 0));
        annotationGroup.add(sprite);
    }
}
function buildBackbone(phi, psi) {
    backboneGroup.clear();
    clearAnnotations();
    backboneGroup.add(annotationGroup);
    const bondLen = 1.47;
    const angle = 109.5 * Math.PI / 180;
    let pos = new THREE.Vector3(0, 0, 0);
    let dir = new THREE.Vector3(1, 0, 0);
    const caMat = new THREE.MeshPhongMaterial({ color: 0x44aaff, emissive: 0x112244 });
    const nMat = new THREE.MeshPhongMaterial({ color: 0x3355cc, emissive: 0x111133 });
    const cMat = new THREE.MeshPhongMaterial({ color: 0xff6644, emissive: 0x331111 });
    const bondMat = new THREE.MeshPhongMaterial({ color: 0xaaaaaa });
    const residues = store.result?.params.residues || 8;
    caPositions = [];
    for (let i = 0; i < residues; i++) {
        const nPos = pos.clone();
        const nSphere = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 16), nMat);
        nSphere.position.copy(nPos);
        backboneGroup.add(nSphere);
        const caPos = nPos.clone().add(dir.clone().multiplyScalar(0.49));
        const caSphere = new THREE.Mesh(new THREE.SphereGeometry(0.30, 16, 16), caMat);
        caSphere.position.copy(caPos);
        backboneGroup.add(caSphere);
        caPositions.push(caPos.clone());
        const cPos = caPos.clone().add(dir.clone().multiplyScalar(0.53));
        const cSphere = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 16), cMat);
        cSphere.position.copy(cPos);
        backboneGroup.add(cSphere);
        for (const [a, b] of [[nPos, caPos], [caPos, cPos]]) {
            const mid = a.clone().add(b).multiplyScalar(0.5);
            const dist = a.distanceTo(b);
            const bondGeom = new THREE.CylinderGeometry(0.07, 0.07, dist, 8);
            const bond = new THREE.Mesh(bondGeom, bondMat);
            bond.position.copy(mid);
            const bLocal = b.clone().sub(a).normalize();
            bond.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), bLocal);
            backboneGroup.add(bond);
        }
        const nextDir = dir.clone();
        nextDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle - Math.PI / 2);
        nextDir.applyAxisAngle(dir, psi * Math.PI / 180);
        pos = cPos.clone().add(nextDir.clone().multiplyScalar(0.49));
        dir = nextDir;
    }
    const box = new THREE.Box3().setFromObject(backboneGroup);
    const center = new THREE.Vector3();
    box.getCenter(center);
    backboneGroup.position.sub(center);
    updateAnnotations();
}
// 把镜头对准指定残基的当前世界位置
function focusResidue(index) {
    const p = caPositions[index - 1];
    if (!p || !camera || !controls)
        return;
    focusedIndex.value = index;
    backboneGroup.updateMatrixWorld(true);
    const world = backboneGroup.localToWorld(p.clone());
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-6)
        dir.set(1, 1, 1);
    dir.normalize();
    controls.target.copy(world);
    camera.position.copy(world.clone().add(dir.multiplyScalar(3.2)));
}
function toggleFocus(index) {
    if (focusedIndex.value === index) {
        focusedIndex.value = null;
        return;
    }
    focusResidue(index);
}
function animate() {
    animationId = requestAnimationFrame(animate);
    // 聚焦期间让镜头跟随该残基（骨架在自动转动），用户仍可正常旋转缩放
    if (focusedIndex.value != null) {
        const p = caPositions[focusedIndex.value - 1];
        if (p) {
            backboneGroup.updateMatrixWorld(true);
            const world = backboneGroup.localToWorld(p.clone());
            const delta = world.clone().sub(controls.target);
            controls.target.copy(world);
            camera.position.add(delta);
        }
    }
    controls.update();
    backboneGroup.rotation.y += 0.001;
    renderer.render(scene, camera);
}
function onResize() {
    if (!container.value)
        return;
    renderer.setSize(container.value.clientWidth, container.value.clientHeight);
    camera.aspect = container.value.clientWidth / container.value.clientHeight;
    camera.updateProjectionMatrix();
}
onMounted(() => {
    initScene();
    buildBackbone(-60, -45);
    animate();
    window.addEventListener('resize', onResize);
});
watch(() => store.selectedConformation, (conf) => {
    focusedIndex.value = null;
    if (conf)
        buildBackbone(conf.phi, conf.psi);
    else
        clearAnnotations();
});
// 清单（构象/展示数量）变化时同步重建标注，保证二者一致
watch(topResidues, () => updateAnnotations());
onUnmounted(() => {
    cancelAnimationFrame(animationId);
    window.removeEventListener('resize', onResize);
    clearAnnotations();
    renderer?.dispose();
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['top-count']} */ ;
/** @type {__VLS_StyleScopedClasses['annotation-list']} */ ;
/** @type {__VLS_StyleScopedClasses['annotation-list']} */ ;
/** @type {__VLS_StyleScopedClasses['annotation-list']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "panel" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "viewer-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ref: "container",
    ...{ class: "viewer3d" },
});
/** @type {typeof __VLS_ctx.container} */ ;
__VLS_asFunctionalElement(__VLS_intrinsicElements.aside, __VLS_intrinsicElements.aside)({
    ...{ class: "annotation-panel" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "annotation-head" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "annotation-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "top-count" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    type: "number",
});
(__VLS_ctx.topCount);
if (!__VLS_ctx.store.selectedConformation) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "annotation-note" },
    });
}
else if (__VLS_ctx.countOutOfRange) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "annotation-note" },
    });
    (__VLS_ctx.topCount === '' ? '空' : __VLS_ctx.topCount);
    (__VLS_ctx.residuesCount);
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.ul, __VLS_intrinsicElements.ul)({
        ...{ class: "annotation-list" },
    });
    for (const [item] of __VLS_getVForSourceType((__VLS_ctx.topResidues))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
            ...{ onClick: (...[$event]) => {
                    if (!!(!__VLS_ctx.store.selectedConformation))
                        return;
                    if (!!(__VLS_ctx.countOutOfRange))
                        return;
                    __VLS_ctx.toggleFocus(item.index);
                } },
            key: (item.index),
            ...{ class: ({ active: item.index === __VLS_ctx.focusedIndex }) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "marker-icon" },
            ...{ class: (`shape-${item.shape}`) },
            ...{ style: ({ '--marker-color': item.color }) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "res-num" },
        });
        (item.index);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "res-angles" },
        });
        (item.phi.toFixed(1));
        (item.psi.toFixed(1));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "res-energy" },
        });
        (item.energy.toFixed(3));
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "annotation-hint" },
    });
}
if (__VLS_ctx.store.selectedConformation) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "info" },
    });
    (__VLS_ctx.store.selectedConformation.phi.toFixed(1));
    (__VLS_ctx.store.selectedConformation.psi.toFixed(1));
    (__VLS_ctx.store.selectedConformation.energy.toFixed(2));
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "info" },
    });
}
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['viewer-row']} */ ;
/** @type {__VLS_StyleScopedClasses['viewer3d']} */ ;
/** @type {__VLS_StyleScopedClasses['annotation-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['annotation-head']} */ ;
/** @type {__VLS_StyleScopedClasses['annotation-title']} */ ;
/** @type {__VLS_StyleScopedClasses['top-count']} */ ;
/** @type {__VLS_StyleScopedClasses['annotation-note']} */ ;
/** @type {__VLS_StyleScopedClasses['annotation-note']} */ ;
/** @type {__VLS_StyleScopedClasses['annotation-list']} */ ;
/** @type {__VLS_StyleScopedClasses['marker-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['res-num']} */ ;
/** @type {__VLS_StyleScopedClasses['res-angles']} */ ;
/** @type {__VLS_StyleScopedClasses['res-energy']} */ ;
/** @type {__VLS_StyleScopedClasses['annotation-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['info']} */ ;
/** @type {__VLS_StyleScopedClasses['info']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            store: store,
            container: container,
            topCount: topCount,
            focusedIndex: focusedIndex,
            residuesCount: residuesCount,
            countOutOfRange: countOutOfRange,
            topResidues: topResidues,
            toggleFocus: toggleFocus,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
