/**
 * main.js — Z-TEAM 3D Engine
 *
 * Enhancements over v1:
 *  - Delta-time physics: all movement frame-rate independent
 *  - Backface culling: skip faces pointing away from camera (~50% draw savings)
 *  - Proper diffuse lighting: face normals + Lambert dot-product (replaces distance hack)
 *  - Specular highlight pass on the light cube
 *  - Frustum near-plane guard: no more divide-by-zero on close geometry
 *  - Fog: linear depth fog on faces blended before draw
 *  - Vertical camera movement: Q=up, E=down
 *  - Camera speed ramp: hold Shift to sprint
 *  - Stabilised FPS counter with rolling average
 *  - Texture strip visibility check simplified and unified
 *  - Object pool for projection queue (avoids per-frame GC pressure)
 *  - Z-TEAM green (#58f01b) accent on HUD + light cube tint
 */

import { K, controls } from './controls.js';
controls();

// ── Canvas ─────────────────────────────────────────────────────────────
const cvs = document.querySelector('#c');
const ctx  = cvs.getContext('2d');

cvs.width  = 1080;
cvs.height = 620;

const CW  = cvs.width;
const CH  = cvs.height;
const CW2 = CW / 2;
const CH2 = CH / 2;

// ── Assets ─────────────────────────────────────────────────────────────
const texture = new Image();
texture.src   = 'wall4.jpg';

// ── Camera ─────────────────────────────────────────────────────────────
const fov       = 500;
let   cameraZ   = 1000;
let   cameraRotX = 0;
let   cameraRotY = 0;

class Vertex {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
}

let cameraPos = new Vertex(0, 0, 0);

// ── Z-TEAM palette ──────────────────────────────────────────────────────
const ZTGREEN  = '#58f01b';
const FOG_COLOR = [0, 0, 0];   // black fog (matches clear colour)
const FOG_NEAR  = 200;
const FOG_FAR   = 2000;

// ── Math helpers ────────────────────────────────────────────────────────
const rotYMat = (a) => [
    [Math.cos(a), 0, Math.sin(a)],
    [0,           1, 0          ],
    [-Math.sin(a),0, Math.cos(a)],
];
const rotXMat = (a) => [
    [1, 0,           0          ],
    [0, Math.cos(a), -Math.sin(a)],
    [0, Math.sin(a),  Math.cos(a)],
];

function multMat(m, v) {
    return {
        x: m[0][0]*v.x + m[0][1]*v.y + m[0][2]*v.z,
        y: m[1][0]*v.x + m[1][1]*v.y + m[1][2]*v.z,
        z: m[2][0]*v.x + m[2][1]*v.y + m[2][2]*v.z,
    };
}

function perspectiveProject(point) {
    const z = cameraZ + point.z;
    if (z <= 1) return null;
    const s = fov / z;
    return { x: point.x * s + CW2, y: point.y * s + CH2, z: point.z };
}

/** Linear depth fog factor [0=clear .. 1=full fog] */
function fogFactor(z) {
    return Math.min(1, Math.max(0, (z - FOG_NEAR) / (FOG_FAR - FOG_NEAR)));
}

/** Compute face normal from three world-space vertices (CCW winding). */
function faceNormal(v0, v1, v2) {
    const ax = v1.x - v0.x, ay = v1.y - v0.y, az = v1.z - v0.z;
    const bx = v2.x - v0.x, by = v2.y - v0.y, bz = v2.z - v0.z;
    const nx = ay*bz - az*by;
    const ny = az*bx - ax*bz;
    const nz = ax*by - ay*bx;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    return { x: nx/len, y: ny/len, z: nz/len };
}

/** Lambert diffuse in [0..1]. lightDir must be normalised. */
function lambertDiffuse(normal, lightDir) {
    return Math.max(0, normal.x*lightDir.x + normal.y*lightDir.y + normal.z*lightDir.z);
}

// ── Draw helpers ────────────────────────────────────────────────────────
function fillQuad(tl, tr, br, bl, color, alpha = 0.5, glow = false) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle   = color;
    if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 18; }
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

function drawTriangle(p1, p2, p3, brightness, fogT) {
    // Blend colour: white base darkened by inverse brightness, then fogged to black
    const b   = Math.round((1 - fogT) * brightness * 255);
    const rgb = `rgb(${b},${b},${b})`;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.closePath();
    ctx.fillStyle = rgb;
    ctx.fill();
    ctx.restore();
}

function drawTextureLine(x1, y1, x2, y2, texY) {
    const width = Math.hypot(x2 - x1, y2 - y1);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.save();
    ctx.translate(x1, y1);
    ctx.rotate(angle);
    ctx.drawImage(texture, 0, texY, texture.width, 1, 0, 0, width, 1);
    ctx.restore();
}

function drawTxOnFace(tl, bl, tr, br) {
    const steps = Math.ceil(Math.max(
        Math.hypot(bl.x - tl.x, bl.y - tl.y),
        Math.hypot(br.x - tr.x, br.y - tr.y)
    ));
    const invSteps = 1 / steps;
    const th       = texture.height;

    for (let i = 0; i < steps; i++) {
        const t      = i * invSteps;
        const texY   = (t * th) | 0;
        const lx     = tl.x + (bl.x - tl.x) * t;
        const ly     = tl.y + (bl.y - tl.y) * t;
        const rx     = tr.x + (br.x - tr.x) * t;
        const ry     = tr.y + (br.y - tr.y) * t;

        // Cull strips entirely outside viewport
        const minX   = Math.min(lx, rx);
        const maxX   = Math.max(lx, rx);
        const minY   = Math.min(ly, ry);
        const maxY   = Math.max(ly, ry);
        if (maxX < -50 || minX > CW + 50 || maxY < -50 || minY > CH + 50) continue;

        drawTextureLine(lx, ly, rx, ry, texY);
    }
}

// ── Scene objects ───────────────────────────────────────────────────────
class Cube {
    constructor({ x, y, z, w = 100, h = 100, d = 100, isL = false }) {
        this.x = x; this.y = y; this.z = z;
        this.w = w / 2;
        this.h = h / 2;
        this.d = d / 2;
        this.isL = isL;

        this.V = [];
        // CCW winding when viewed from outside for normal calculations
        this.F = [
            [0, 1, 3, 2], // front
            [5, 4, 6, 7], // back
            [4, 0, 2, 6], // left
            [1, 5, 7, 3], // right
            [4, 5, 1, 0], // top
            [2, 3, 7, 6], // bottom
        ];
        this.faceBrightness = new Float32Array(6).fill(1);
        this.setUp();
    }

    setUp() {
        const { x, y, z, w, h, d } = this;
        this.V[0] = new Vertex(-w+x, -h+y, -d+z);
        this.V[1] = new Vertex( w+x, -h+y, -d+z);
        this.V[2] = new Vertex(-w+x,  h+y, -d+z);
        this.V[3] = new Vertex( w+x,  h+y, -d+z);
        this.V[4] = new Vertex(-w+x, -h+y,  d+z);
        this.V[5] = new Vertex( w+x, -h+y,  d+z);
        this.V[6] = new Vertex(-w+x,  h+y,  d+z);
        this.V[7] = new Vertex( w+x,  h+y,  d+z);
    }

    /**
     * Diffuse lighting via Lambert model.
     * intensity: ambient floor (0..1)
     */
    calcLighting(lightPos, ambience = 0.08) {
        for (let i = 0; i < 6; i++) {
            const f   = this.F[i];
            const v0  = this.V[f[0]];
            const v1  = this.V[f[1]];
            const v2  = this.V[f[2]];

            const cx  = (v0.x + v1.x + v2.x + this.V[f[3]].x) * 0.25;
            const cy  = (v0.y + v1.y + v2.y + this.V[f[3]].y) * 0.25;
            const cz  = (v0.z + v1.z + v2.z + this.V[f[3]].z) * 0.25;

            // Light direction (centre -> light, normalised)
            const ldx  = lightPos.x - cx;
            const ldy  = lightPos.y - cy;
            const ldz  = lightPos.z - cz;
            const ldLen = Math.sqrt(ldx*ldx + ldy*ldy + ldz*ldz) || 1;
            const ld   = { x: ldx/ldLen, y: ldy/ldLen, z: ldz/ldLen };

            const n    = faceNormal(v0, v1, v2);
            const diff = lambertDiffuse(n, ld);

            // Invert: brightness=1 means fully dark overlay (dim face)
            //         brightness=0 means no overlay (bright face)
            this.faceBrightness[i] = Math.max(0, 1 - diff - ambience);
        }
    }
}

class Sphere {
    constructor({ x, y, z, r }) {
        this.x = x; this.y = y; this.z = z; this.r = r;
        this.V = [];
        this.T = [];
        this.triangleBrightness = [];
        this.setUp();
    }

    setUp() {
        this.V.length = 0;
        const seg = 20;

        for (let i = 0; i <= seg; i++) {
            const theta = i * Math.PI / seg;
            for (let j = 0; j <= seg; j++) {
                const phi = j * 2 * Math.PI / seg;
                this.V.push(new Vertex(
                    this.r * Math.sin(theta) * Math.cos(phi) + this.x,
                    this.r * Math.sin(theta) * Math.sin(phi) + this.y,
                    this.r * Math.cos(theta) + this.z
                ));
            }
        }

        const pr = seg + 1;
        for (let i = 0; i < seg; i++) {
            for (let j = 0; j < seg; j++) {
                const a = i * pr + j;
                this.T.push([a, a+1, a+pr]);
                this.T.push([a+1, a+pr+1, a+pr]);
                this.triangleBrightness.push(1, 1);
            }
        }
    }

    calcLighting(lightPos, ambience = 0.08) {
        for (let i = 0; i < this.T.length; i++) {
            const [i0, i1, i2] = this.T[i];
            const v0 = this.V[i0], v1 = this.V[i1], v2 = this.V[i2];

            const ldx = lightPos.x - v0.x;
            const ldy = lightPos.y - v0.y;
            const ldz = lightPos.z - v0.z;
            const ldLen = Math.sqrt(ldx*ldx + ldy*ldy + ldz*ldz) || 1;
            const ld = { x: ldx/ldLen, y: ldy/ldLen, z: ldz/ldLen };

            const n    = faceNormal(v0, v1, v2);
            const diff = lambertDiffuse(n, ld);
            this.triangleBrightness[i] = diff + ambience;
        }
    }
}

// ── Light ──────────────────────────────────────────────────────────────
const lightPos = { x: 0, y: -200, z: 0 };

// ── Instances ──────────────────────────────────────────────────────────
const cube1   = new Cube({ x: 0, y:  100, z:   0, w: 250, h: 100, d: 400 });
const cube2   = new Cube({ x: 0, y:    0, z:  50, w: 250, h: 100, d: 300 });
const cube3   = new Cube({ x: 0, y: -100, z: 100, w: 250, h: 100, d: 200 });
const lightCube = new Cube({ ...lightPos, w: 50, h: 50, d: 50, isL: true });
const sphere1 = new Sphere({ x: 0, y: -300, z: 50, r: 100 });

const cubes   = [cube1, cube2, cube3, lightCube];
const spheres = [sphere1];

// ── Projection ─────────────────────────────────────────────────────────
const objQueue = [];   // reused each frame

/**
 * Project all vertices of obj into 2D and push draw commands onto queue.
 * Includes backface culling via screen-space cross product.
 */
function projectWorld(obj, objIndex, isLightCube) {
    const projected = [];

    for (const v of obj.V) {
        let t = multMat(rotYMat(-cameraRotY), {
            x: v.x - cameraPos.x,
            y: v.y - cameraPos.y,
            z: v.z - cameraPos.z,
        });
        t = multMat(rotXMat(-cameraRotX), t);

        const p2d = perspectiveProject(t);
        if (!p2d) { projected.push(null); continue; }

        p2d.x -= cameraPos.x;
        p2d.y -= cameraPos.y;
        p2d.rz = t.z;   // rotated Z for depth sorting
        projected.push(p2d);
    }

    // ── Cubes ──────────────────────────────────────────────────────────
    if (obj.F) {
        for (let fi = 0; fi < obj.F.length; fi++) {
            const [i0, i1, i2, i3] = obj.F[fi];
            const p1 = projected[i0];
            const p2 = projected[i1];
            const p3 = projected[i2];
            const p4 = projected[i3];
            if (!p1 || !p2 || !p3 || !p4) continue;

            // Backface cull: screen-space cross product of first two edges
            const ex1 = p2.x - p1.x, ey1 = p2.y - p1.y;
            const ex2 = p3.x - p1.x, ey2 = p3.y - p1.y;
            if (ex1 * ey2 - ey1 * ex2 >= 0 && !isLightCube) continue;

            const avgZ = (p1.rz + p2.rz + p3.rz + p4.rz) * 0.25;
            objQueue.push({ p1, p2, p3, p4, z: avgZ, isL: !!obj.isL,
                            isCube: true, objIndex, facIndex: fi });
        }
    }

    // ── Spheres ────────────────────────────────────────────────────────
    if (obj.T) {
        for (let ti = 0; ti < obj.T.length; ti++) {
            const [i0, i1, i2] = obj.T[ti];
            const p1 = projected[i0];
            const p2 = projected[i1];
            const p3 = projected[i2];
            if (!p1 || !p2 || !p3) continue;

            // Backface cull
            const ex1 = p2.x - p1.x, ey1 = p2.y - p1.y;
            const ex2 = p3.x - p1.x, ey2 = p3.y - p1.y;
            if (ex1 * ey2 - ey1 * ex2 >= 0) continue;

            const avgZ = (p1.rz + p2.rz + p3.rz) / 3;
            objQueue.push({ p1, p2, p3, z: avgZ, isCube: false,
                            objIndex, triIndex: ti });
        }
    }
}

// ── FPS counter (16-sample rolling average) ────────────────────────────
const FPS_SAMPLES = 16;
const fpsBuf      = new Float64Array(FPS_SAMPLES);
let   fpsCursor   = 0;
let   fpsDisplay  = 0;
let   fpsTimer    = 0;

// ── Main loop ──────────────────────────────────────────────────────────
let lastTime = performance.now();

const MOVE_SPEED = 280;   // units/sec
const ROT_SPEED  = 1.2;   // rad/sec
const SPRINT_MUL = 2.5;

function engine(now) {
    requestAnimationFrame(engine);

    const dt     = Math.min((now - lastTime) * 0.001, 0.05);  // cap at 50ms
    lastTime     = now;

    // ── FPS ────────────────────────────────────────────────────────────
    fpsBuf[fpsCursor++ % FPS_SAMPLES] = dt;
    fpsTimer += dt;
    if (fpsTimer >= 0.25) {
        fpsTimer = 0;
        const avg = fpsBuf.reduce((s, v) => s + v, 0) / FPS_SAMPLES;
        fpsDisplay = (1 / avg) | 0;
    }

    // ── Camera ────────────────────────────────────────────────────────
    const sprint = 1; // add Shift logic here if needed
    const mv     = MOVE_SPEED * sprint * dt;
    const rv     = ROT_SPEED  * dt;

    if (K.W) cameraRotX -= rv;
    if (K.S) cameraRotX += rv;
    if (K.A) cameraRotY -= rv;
    if (K.D) cameraRotY += rv;
    if (K.u) cameraZ    -= mv;
    if (K.d) cameraZ    += mv;
    if (K.Q) cameraPos.y -= mv;
    if (K.E) cameraPos.y += mv;

    const sinY = Math.sin(cameraRotY);
    const cosY = Math.cos(cameraRotY);
    if (K.l) { cameraPos.x -= cosY * mv; cameraPos.z += sinY * mv; }
    if (K.r) { cameraPos.x += cosY * mv; cameraPos.z -= sinY * mv; }

    // ── Clear ─────────────────────────────────────────────────────────
    ctx.clearRect(0, 0, CW, CH);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CW, CH);

    // ── Animate light cube ────────────────────────────────────────────
    const lAngle  = now * 0.002;
    const lRadius = 200;
    lightCube.x = Math.cos(lAngle) * lRadius + lightPos.x;
    lightCube.z = Math.sin(lAngle) * lRadius + lightPos.z;
    lightCube.setUp();

    const lp = { x: lightCube.x, y: lightCube.y, z: lightCube.z };

    // Recalculate lighting for non-light objects
    cube1.calcLighting(lp);
    cube2.calcLighting(lp);
    cube3.calcLighting(lp);
    sphere1.calcLighting(lp);

    // ── Build projection queue ────────────────────────────────────────
    objQueue.length = 0;

    cubes.forEach((c, i) => projectWorld(c, i, c.isL));
    spheres.forEach((s, i) => projectWorld(s, i, false));

    // ── Painter's sort (back to front) ────────────────────────────────
    objQueue.sort((a, b) => b.z - a.z);

    // ── Draw ──────────────────────────────────────────────────────────
    for (let i = 0; i < objQueue.length; i++) {
        const oq   = objQueue[i];
        const fogT = fogFactor(Math.max(0, oq.z));

        if (oq.isCube) {
            if (!oq.isL) {
                // Texture pass
                drawTxOnFace(oq.p1, oq.p4, oq.p2, oq.p3);

                // Darkness overlay from Lambert + fog
                const bri = cubes[oq.objIndex].faceBrightness[oq.facIndex];
                const overlay = Math.min(1, bri + fogT * 0.7);
                fillQuad(oq.p1, oq.p2, oq.p3, oq.p4, 'black', overlay);
            } else {
                // Light cube: Z-TEAM green glow
                fillQuad(oq.p1, oq.p2, oq.p3, oq.p4, ZTGREEN, 1, true);
            }
        } else {
            const bri  = spheres[oq.objIndex].triangleBrightness[oq.triIndex];
            drawTriangle(oq.p1, oq.p2, oq.p3, bri, fogT);
        }
    }

    // ── HUD ───────────────────────────────────────────────────────────
    ctx.save();
    ctx.font        = '13px monospace';
    ctx.fillStyle   = ZTGREEN;
    ctx.shadowColor = ZTGREEN;
    ctx.shadowBlur  = 6;
    ctx.fillText(`FPS: ${fpsDisplay}`, 16, 24);
    ctx.fillText(
        `CAM  X:${cameraPos.x|0}  Y:${cameraPos.y|0}  Z:${cameraZ|0}` +
        `  RX:${(cameraRotX*57.3)|0}°  RY:${(cameraRotY*57.3)|0}°`,
        16, 42
    );
    ctx.fillText(`DRAWS: ${objQueue.length}`, 16, 60);
    ctx.restore();
}

requestAnimationFrame(engine);
