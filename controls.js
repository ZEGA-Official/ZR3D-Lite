/**
 * controls.js — Z-TEAM Input System (Self-Contained WASM)
 *
 * Zero external dependencies — WASM binary is embedded as base64.
 * Drop this file in your project and go.
 *
 * Exports:
 *   K          — live Proxy, same API as the original object literal
 *   controls() — registers DOM listeners (idempotent)
 *   loadWasm() — explicit init (auto-called by controls())
 *
 * WASM internals (compiled from WAT, 198 bytes):
 *   key_down(id)  — set bit, blocks if opposite key is held
 *   key_up(id)    — clear bit
 *   get_state()   — return packed uint16 bitfield
 *   reset_state() — zero all keys (called on window blur)
 *
 * Key ID table (mirrors WASM opposites data segment):
 *   r=0  l=1  u=2  d=3  W=4  A=5  S=6  D=7  Q=8  E=9
 * Opposite pairs: (r<->l) (u<->d) (W<->S) (A<->D) (Q<->E)
 */

// ── Embedded WASM (compiled WAT -> binary -> base64, 198 bytes) ───────
const WASM_B64 =
    'AGFzbQEAAAABDANgAX8AYAABf2AAAAMFBAAAAQIFAwEAAQYGAX8BQQALBzUFA21lbQIA' +
    'CGtleV9kb3duAAAGa2V5X3VwAAEJZ2V0X3N0YXRlAAILcmVzZXRfc3RhdGUAAwpRBC' +
    'oBAX8gAEEKTwRADwsgAC0AACEBIwBBASABdHEEQA8LIwBBASAAdHIkAAsYACAAQQpP' +
    'BEAPCyMAQQEgAHRBf3NxJAALBAAjAAsGAEEAJAALCxABAEEACwoBAAMCBgcEBQkI';

// ── Key ID constants ──────────────────────────────────────────────────
const KEY_ID = Object.freeze({
    r: 0, l: 1, u: 2, d: 3,
    W: 4, A: 5, S: 6, D: 7,
    Q: 8, E: 9,
});

// ── DOM key string -> [K prop, WASM id] ──────────────────────────────
const KEY_MAP = Object.freeze({
    ArrowRight: ['r', 0],
    ArrowLeft:  ['l', 1],
    ArrowUp:    ['u', 2],
    ArrowDown:  ['d', 3],
    w:          ['W', 4],
    a:          ['A', 5],
    s:          ['S', 6],
    d:          ['D', 7],
    q:          ['Q', 8],
    e:          ['E', 9],
});

// ── WASM runtime ──────────────────────────────────────────────────────
let _wasm  = null;
let _ready = false;
let _initP = null;  // in-flight promise guard

/** Decode base64 -> Uint8Array without atob length limits. */
function _b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * loadWasm() — instantiate the embedded WASM module.
 * Idempotent + concurrent-safe: multiple callers get same Promise.
 * @returns {Promise<void>}
 */
function loadWasm() {
    if (_ready) return Promise.resolve();
    if (_initP) return _initP;

    _initP = WebAssembly
        .instantiate(_b64ToBytes(WASM_B64), {})
        .then(({ instance }) => {
            const e = instance.exports;
            _wasm = {
                key_down:    e.key_down,
                key_up:      e.key_up,
                get_state:   e.get_state,
                reset_state: e.reset_state,
            };
            _ready = true;
        });

    return _initP;
}

// ── K — live Proxy over the WASM bitfield ─────────────────────────────
/**
 * K.r / K.l / K.u / K.d / K.W / K.A / K.S / K.D / K.Q / K.E
 *
 * Each property read calls get_state() + bit-tests inline.
 * Writes are silently rejected — WASM owns the state.
 *
 * @type {{ r:boolean, l:boolean, u:boolean, d:boolean,
 *          W:boolean, A:boolean, S:boolean, D:boolean,
 *          Q:boolean, E:boolean }}
 */
const K = new Proxy(
    Object.freeze({ r:false, l:false, u:false, d:false,
                    W:false, A:false, S:false, D:false,
                    Q:false, E:false }),
    {
        get(_, prop) {
            const id = KEY_ID[prop];
            if (id === undefined || !_ready) return false;
            return (_wasm.get_state() >>> id & 1) === 1;
        },
        set() { return true; },  // reject all writes
    }
);

// ── controls() — idempotent DOM listener setup ────────────────────────
let _registered = false;

/**
 * controls() — attach keydown / keyup / blur listeners.
 * Kicks off loadWasm() automatically. Safe to call multiple times.
 * Same function name as the original — zero migration cost.
 */
function controls() {
    if (!_ready && !_initP) loadWasm();
    if (_registered) return;
    _registered = true;

    document.addEventListener('keydown', (e) => {
        if (e.repeat || !_ready) return;
        const entry = KEY_MAP[e.key];
        if (entry) _wasm.key_down(entry[1]);
    }, { passive: true });

    document.addEventListener('keyup', (e) => {
        if (!_ready) return;
        const entry = KEY_MAP[e.key];
        if (entry) _wasm.key_up(entry[1]);
    }, { passive: true });

    // Zero all bits on focus loss — prevents stuck keys
    window.addEventListener('blur', () => {
        if (_ready) _wasm.reset_state();
    }, { passive: true });
}

export { K, controls, loadWasm, KEY_ID, KEY_MAP };
