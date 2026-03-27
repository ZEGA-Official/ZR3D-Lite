/**
 * controls.js — Z-TEAM WASM Input Bridge
 *
 * Loads controls.wasm, maps DOM key events → WASM bitfield, and exposes:
 *   K        — live read-only Proxy over the WASM state (same API as before)
 *   controls — registers all listeners (call once, idempotent)
 *
 * Key IDs (must match controls.c):
 *   r=0  l=1  u=2  d=3  W=4  A=5  S=6  D=7  Q=8  E=9
 *
 * Usage:
 *   import { K, controls } from './controls.js';
 *   controls();                   // hook up input
 *   if (K.W && K.r) { ... }       // same API as before
 */

// ── Key ID constants (mirrors controls.c) ─────────────────────────────
const KEY_ID = Object.freeze({
    r: 0, l: 1, u: 2, d: 3,
    W: 4, A: 5, S: 6, D: 7,
    Q: 8, E: 9,
});

// ── DOM key → [K property name, key ID] ───────────────────────────────
const KEY_MAP = Object.freeze({
    ArrowRight: ['r', KEY_ID.r],
    ArrowLeft:  ['l', KEY_ID.l],
    ArrowUp:    ['u', KEY_ID.u],
    ArrowDown:  ['d', KEY_ID.d],
    w:          ['W', KEY_ID.W],
    a:          ['A', KEY_ID.A],
    s:          ['S', KEY_ID.S],
    d:          ['D', KEY_ID.D],
    q:          ['Q', KEY_ID.Q],
    e:          ['E', KEY_ID.E],
});

// ── WASM module singleton ──────────────────────────────────────────────
let _wasm = null;   // { key_down, key_up, get_state, reset_state }
let _ready = false;

/**
 * loadWasm(url) — fetch, compile, and instantiate controls.wasm.
 * Returns a Promise that resolves once the module is live.
 * Safe to await multiple times — only instantiates once.
 *
 * @param {string} [url='./controls.wasm']
 * @returns {Promise<void>}
 */
async function loadWasm(url = './controls.wasm') {
    if (_ready) return;

    // Prefer streaming instantiation (single parse pass, fastest path).
    const instantiate = typeof WebAssembly.instantiateStreaming === 'function'
        ? () => WebAssembly.instantiateStreaming(fetch(url), {})
        : async () => {
              const buf = await (await fetch(url)).arrayBuffer();
              return WebAssembly.instantiate(buf, {});
          };

    const { instance } = await instantiate();
    const exp = instance.exports;

    _wasm = {
        key_down:    /** @type {(id: number) => void}   */ (exp.key_down),
        key_up:      /** @type {(id: number) => void}   */ (exp.key_up),
        get_state:   /** @type {() => number}            */ (exp.get_state),
        reset_state: /** @type {() => void}              */ (exp.reset_state),
    };
    _ready = true;
}

// ── K — live Proxy that reads the WASM bitfield ────────────────────────
/**
 * K mirrors the original object literal API.
 * Reading K.W returns true if the W key is currently held.
 * Writing K.* is a no-op (state is owned by WASM).
 *
 * @type {{ r:boolean, l:boolean, u:boolean, d:boolean,
 *          W:boolean, A:boolean, S:boolean, D:boolean,
 *          Q:boolean, E:boolean }}
 */
const K = new Proxy(Object.freeze({ r:false, l:false, u:false, d:false,
                                    W:false, A:false, S:false, D:false,
                                    Q:false, E:false }),
{
    get(_, prop) {
        if (!_ready || !(prop in KEY_ID)) return false;
        // Single WASM call per frame read — bit-test inline.
        return (/** @type {number} */ (_wasm.get_state()) & (1 << KEY_ID[prop])) !== 0;
    },
    set() {
        // State is owned by WASM — reject all JS-side writes.
        return true;
    },
});

// ── controls() — idempotent listener registration ─────────────────────
let _registered = false;

/**
 * controls() — attach keydown / keyup / blur listeners to document.
 * Idempotent: safe to call multiple times, wires up only once.
 * Mirrors the original function signature exactly.
 *
 * Must be called after loadWasm() resolves (or it queues gracefully).
 */
function controls() {
    if (_registered) return;
    _registered = true;

    /**
     * Fast path: look up key in KEY_MAP, call into WASM.
     * Unknown keys take zero branches after the map miss.
     */
    document.addEventListener('keydown', (e) => {
        if (e.repeat) return;           // ignore held-key auto-repeat
        const entry = KEY_MAP[e.key];
        if (entry && _ready) _wasm.key_down(entry[1]);
    }, { passive: true });

    document.addEventListener('keyup', (e) => {
        const entry = KEY_MAP[e.key];
        if (entry && _ready) _wasm.key_up(entry[1]);
    }, { passive: true });

    // Zero all keys when the window loses focus — prevents stuck keys.
    window.addEventListener('blur', () => {
        if (_ready) _wasm.reset_state();
    }, { passive: true });
}

// ── Public API ─────────────────────────────────────────────────────────
export { K, controls, loadWasm, KEY_ID, KEY_MAP };
