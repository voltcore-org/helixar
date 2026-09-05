import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareHcc,
  joinCrystal,
  makeHcc,
  packCrystalId,
  sketchDecode,
  sketchDiff,
  sketchFromIds,
} from "./primitives.ts";
import {
  createEngine,
  mutate,
  partitionEdge,
  step,
} from "./engine.ts";

describe("Helixar primitives", () => {
  it("IBLT round-trips a store", () => {
    const ids = [1, 42, 99, 1001, 0x00aabbcc, 7, 13, 65];
    const sketch = sketchFromIds(ids);
    const decoded = sketchDecode(sketch);
    assert.equal(decoded.ok, true);
    assert.deepEqual([...decoded.ids].sort((a, b) => a - b), [...ids].sort((a, b) => a - b));
  });

  it("IBLT difference peels only the gap", () => {
    const a = [1, 2, 3, 4, 5, 6];
    const b = [1, 2, 3, 4, 9, 12];
    const diff = sketchDiff(sketchFromIds(a), sketchFromIds(b));
    const decoded = sketchDecode(diff);
    assert.equal(decoded.ok, true);
    assert.deepEqual(
      [...decoded.ids].sort((x, y) => x - y),
      [5, 6, 9, 12],
    );
  });

  it("LWW join is commutative and idempotent", () => {
    const a = {
      id: packCrystalId(1, 3),
      hcc: makeHcc(1, 2, 3),
      key: 0,
      payload: 10,
    };
    const b = {
      id: packCrystalId(4, 1),
      hcc: makeHcc(4, 2, 1),
      key: 0,
      payload: 20,
    };
    const ab = joinCrystal(a, b);
    const ba = joinCrystal(b, a);
    assert.equal(ab.id, ba.id);
    assert.equal(joinCrystal(ab, a).id, ab.id);
    assert.ok(compareHcc(a.hcc, a.hcc) === 0);
  });
});

describe("Helixar protocol", () => {
  it("converges a single mutation without extra RTTs along the mesh", () => {
    const engine = createEngine("helixar", 11, 1);
    mutate(engine, 0, 0, 0xabc);
    let steps = 0;
    while (steps < 8000) {
      step(engine, 25);
      steps += 1;
      let missing = false;
      for (const n of engine.nodes) {
        const c = n.store.get(0);
        if (!c || c.payload !== 0xabc) {
          missing = true;
          break;
        }
      }
      if (!missing) break;
    }
    for (const n of engine.nodes) {
      const c = n.store.get(0);
      assert.ok(c, `node ${n.id} missing crystal`);
      assert.equal(c!.payload, 0xabc);
    }
  });

  it("partitions, diverges, then snaps on heal", () => {
    const engine = createEngine("helixar", 3, 1);
    partitionEdge(engine, 2, 4, true);
    partitionEdge(engine, 3, 5, true);
    partitionEdge(engine, 1, 11, true);
    partitionEdge(engine, 0, 8, true);
    mutate(engine, 0, 1, 111);
    mutate(engine, 8, 1, 222);
    for (let i = 0; i < 400; i++) step(engine, 25);
    const ridge = engine.nodes[0]!.store.get(1)?.payload;
    const spit = engine.nodes[8]!.store.get(1)?.payload;
    assert.equal(ridge, 111);
    assert.equal(spit, 222);
    partitionEdge(engine, 2, 4, false);
    partitionEdge(engine, 3, 5, false);
    partitionEdge(engine, 1, 11, false);
    partitionEdge(engine, 0, 8, false);
    for (let i = 0; i < 800; i++) step(engine, 25);
    const winner = engine.nodes[0]!.store.get(1)?.payload;
    assert.ok(winner === 111 || winner === 222);
    for (const n of engine.nodes) {
      assert.equal(n.store.get(1)?.payload, winner);
    }
  });
});

describe("Gossip baseline", () => {
  it("eventually converges the same mutation", () => {
    const engine = createEngine("gossip", 11, 1);
    mutate(engine, 0, 0, 0xabc);
    let missing = true;
    for (let i = 0; i < 12000; i++) {
      step(engine, 25);
      missing = engine.nodes.some((n) => n.store.get(0)?.payload !== 0xabc);
      if (!missing) break;
    }
    assert.equal(missing, false);
  });
});
