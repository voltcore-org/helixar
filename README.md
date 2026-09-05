# Helixar

**PHCS — Predictive Horizon Crystal Sync**

Real-time replica unison for high-latency, partially connected mesh networks. One-way wakes. No RTT-gated handshake. No *O(N)* version vectors.

## Engine

| Layer | Role |
|---|---|
| Helical Causal Coordinate | *O(1)* LWW order: `(author, epoch, spin, phase)` |
| Spiral Crystal Index | Morton `(key, helix-time)` gap scans |
| Invertible Crystal Sketch | 32-cell IBLT; one-datagram set difference |
| Predicted Horizon Field | *O(D)* neighbor ETA, never wait for ACK |
| Wake diffraction | Huygens suppression + `α·delay` slack coalesce |
| Horizon freeze + snap | Partition stop-speculate; heal streams the peel |

Core: `src/lib/helixar/` (`primitives.ts`, `engine.ts`, `types.ts`). Twin-sim compares PHCS against epidemic gossip on the same mutation schedule.

## Complexity

Per node: **O(K + D)** space. `mutate`: **O(D + K)**. `step`: **O(P + N·D·K)** with *P* bounded. Convergence wall-clock ≈ latency-weighted shortest path (one-way).

## Console

Instrument view of a 12-node, three-cluster mesh. Inject mutations, cut bridges, heal, compare Helixar vs gossip TTC/bytes/wakes.

```bash
npm install
npm run dev
```

Auth and database are off. Replica state is in-memory for the live lattice.

## Tests

```bash
node --experimental-strip-types --test src/lib/helixar/helixar.test.ts
```
