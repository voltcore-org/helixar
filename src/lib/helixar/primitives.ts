/**
 * Helixar primitives: helical coordinates, spiral index, IBLT sketch, LWW join.
 * All public functions are pure aside from in-place sketch mix (explicit).
 */

import {
  BLOOM_WORDS,
  SKETCH_CELLS,
  type Crystal,
  type CrystalId,
  type CrystalSketch,
  type HelicalCausalCoordinate,
  type KeyId,
  type NodeId,
  type SketchCell,
} from "./types.ts";

/** Murmur-derived 32-bit mix. O(1) */
export function hash32(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** O(1) */
export function hash16(x: number): number {
  return hash32(x) & 0xffff;
}

/** Deterministic mulberry32. O(1) */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pack author (8) + spin (24) into a nonzero CrystalId.
 * O(1) space/time.
 */
export function packCrystalId(author: NodeId, spin: number): CrystalId {
  const id = ((author & 0xff) << 24) | (spin & 0xffffff);
  return id === 0 ? 1 : id;
}

/** Helical causal coordinate. Phase is a hash-ring angle, not a clock. O(1) */
export function makeHcc(
  author: NodeId,
  epoch: number,
  spin: number,
): HelicalCausalCoordinate {
  return {
    author,
    epoch,
    spin,
    phase: hash16(author * 1_000_003 + spin + epoch * 17),
  };
}

/**
 * Total order used for LWW join. Same-author spins are causal;
 * cross-author ties break on phase then author (deterministic, not "later").
 * O(1)
 */
export function compareHcc(
  a: HelicalCausalCoordinate,
  b: HelicalCausalCoordinate,
): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  if (a.author === b.author) return a.spin - b.spin;
  if (a.phase !== b.phase) return a.phase - b.phase;
  return a.author - b.author;
}

/** Idempotent commutative join of two LWW crystals. O(1) */
export function joinCrystal(a: Crystal, b: Crystal): Crystal {
  return compareHcc(a.hcc, b.hcc) >= 0 ? a : b;
}

/**
 * Morton/Z-order of (key-hash, helix-time) — the spiral crystal index.
 * Nearby keys and nearby epochs co-locate, so gap scans are sequential.
 * O(1)
 */
export function spiralIndex(key: KeyId, hcc: HelicalCausalCoordinate): number {
  const k = hash16(key * 2654435761);
  const t = hash16((hcc.epoch << 8) ^ hcc.spin ^ (hcc.author * 31));
  return morton16(k, t);
}

function morton16(x: number, y: number): number {
  return (spread8(x & 0xff) | (spread8(y & 0xff) << 1)) >>> 0;
}

function spread8(v: number): number {
  let x = v & 0xff;
  x = (x | (x << 4)) & 0x0f0f;
  x = (x | (x << 2)) & 0x3333;
  x = (x | (x << 1)) & 0x5555;
  return x;
}

/** Empty invertible bloom lookup table. O(m) space, m = SKETCH_CELLS. */
export function emptySketch(): CrystalSketch {
  const cells: SketchCell[] = new Array<SketchCell>(SKETCH_CELLS);
  for (let i = 0; i < SKETCH_CELLS; i++) {
    cells[i] = { count: 0, xorId: 0, xorHash: 0 };
  }
  return { cells };
}

function sketchIndexes(id: CrystalId): [number, number, number] {
  const m = SKETCH_CELLS;
  let a = hash32(id) % m;
  let b = hash32(id ^ 0x9e3779b9) % m;
  let c = hash32(id ^ 0x85ebca6b) % m;
  if (b === a) b = (b + 1) % m;
  if (c === a || c === b) c = (c + 1) % m;
  if (c === a || c === b) c = (c + 2) % m;
  return [a, b, c];
}

function mixCell(cell: SketchCell, id: CrystalId, dir: 1 | -1): void {
  cell.count += dir;
  cell.xorId ^= id;
  cell.xorHash ^= hash32(id);
}

/** O(1) — three cell updates. */
export function sketchAdd(sketch: CrystalSketch, id: CrystalId): void {
  if (id === 0) return;
  const [a, b, c] = sketchIndexes(id);
  mixCell(sketch.cells[a]!, id, 1);
  mixCell(sketch.cells[b]!, id, 1);
  mixCell(sketch.cells[c]!, id, 1);
}

/** O(1) */
export function sketchRemove(sketch: CrystalSketch, id: CrystalId): void {
  if (id === 0) return;
  const [a, b, c] = sketchIndexes(id);
  mixCell(sketch.cells[a]!, id, -1);
  mixCell(sketch.cells[b]!, id, -1);
  mixCell(sketch.cells[c]!, id, -1);
}

/** O(K) for K crystals. */
export function sketchFromIds(ids: Iterable<CrystalId>): CrystalSketch {
  const sketch = emptySketch();
  for (const id of ids) sketchAdd(sketch, id);
  return sketch;
}

/** Cellwise a − b. O(m). */
export function sketchDiff(a: CrystalSketch, b: CrystalSketch): CrystalSketch {
  const out = emptySketch();
  for (let i = 0; i < SKETCH_CELLS; i++) {
    const ca = a.cells[i]!;
    const cb = b.cells[i]!;
    const o = out.cells[i]!;
    o.count = ca.count - cb.count;
    o.xorId = ca.xorId ^ cb.xorId;
    o.xorHash = ca.xorHash ^ cb.xorHash;
  }
  return out;
}

/**
 * Peel an IBLT. Recovers set difference when |Δ| is below cell capacity.
 * Time O(m + d), space O(d).
 */
export function sketchDecode(
  sketch: CrystalSketch,
): { ids: CrystalId[]; ok: boolean } {
  const cells: SketchCell[] = sketch.cells.map((c) => ({ ...c }));
  const ids: CrystalId[] = [];
  const pending: number[] = [];

  const enqueuePure = (i: number) => {
    const cell = cells[i]!;
    if (cell.count !== 1 && cell.count !== -1) return;
    if (cell.xorId === 0) return;
    if (hash32(cell.xorId) !== (cell.xorHash >>> 0)) return;
    pending.push(i);
  };

  for (let i = 0; i < cells.length; i++) enqueuePure(i);

  while (pending.length > 0) {
    const i = pending.pop()!;
    const cell = cells[i]!;
    if (cell.count !== 1 && cell.count !== -1) continue;
    const id = cell.xorId;
    if (id === 0 || hash32(id) !== (cell.xorHash >>> 0)) continue;
    const dir: 1 | -1 = cell.count === 1 ? 1 : -1;
    ids.push(id);
    const [a, b, c] = sketchIndexes(id);
    for (const j of [a, b, c]) {
      mixCell(cells[j]!, id, dir === 1 ? -1 : 1);
    }
    enqueuePure(a);
    enqueuePure(b);
    enqueuePure(c);
  }

  let ok = true;
  for (const cell of cells) {
    if (cell.count !== 0 || cell.xorId !== 0 || cell.xorHash !== 0) {
      ok = false;
      break;
    }
  }
  return { ids, ok };
}

/** 256-bit bloom of crystal ids. O(1) insert/query, O(1) space. */
export function emptyBloom(): Uint32Array {
  return new Uint32Array(BLOOM_WORDS);
}

export function bloomAdd(bloom: Uint32Array, id: CrystalId): void {
  const h1 = hash32(id);
  const h2 = hash32(id ^ 0xc2b2ae35);
  const h3 = hash32(id ^ 0x27d4eb2f);
  setBit(bloom, h1);
  setBit(bloom, h2);
  setBit(bloom, h3);
}

export function bloomHas(bloom: Uint32Array, id: CrystalId): boolean {
  const h1 = hash32(id);
  const h2 = hash32(id ^ 0xc2b2ae35);
  const h3 = hash32(id ^ 0x27d4eb2f);
  return testBit(bloom, h1) && testBit(bloom, h2) && testBit(bloom, h3);
}

function setBit(bloom: Uint32Array, h: number): void {
  const bit = h % (BLOOM_WORDS * 32);
  bloom[bit >>> 5]! |= 1 << (bit & 31);
}

function testBit(bloom: Uint32Array, h: number): boolean {
  const bit = h % (BLOOM_WORDS * 32);
  return (bloom[bit >>> 5]! & (1 << (bit & 31))) !== 0;
}

/** XOR-fold of crystal ids for a compact replica fingerprint. O(K) */
export function fingerprintStore(store: Map<KeyId, Crystal>): number {
  let acc = 0x811c9dc5;
  for (const crystal of store.values()) {
    acc ^= crystal.id;
    acc = Math.imul(acc, 16777619);
    acc ^= crystal.payload;
  }
  return acc >>> 0;
}

/** Packet size model: 24B header + 16B/crystal + 8B/sketch cell. O(1) */
export function packetBytes(crystalCount: number, isBeacon: boolean): number {
  const sketch = isBeacon ? SKETCH_CELLS * 8 : 16;
  return 24 + crystalCount * 16 + sketch;
}

export function cloneSketch(src: CrystalSketch): CrystalSketch {
  return { cells: src.cells.map((c) => ({ ...c })) };
}
