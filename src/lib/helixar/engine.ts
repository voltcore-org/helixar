/**
 * Helixar engine — discrete-time mesh simulator + both protocol cores.
 *
 * Public API complexity (N nodes, D avg degree, K keys, P inflight packets):
 *   createEngine   O(N·D + K)
 *   step           O(P + N·D·K) per tick; P ≤ MAX_INFLIGHT
 *   mutate         O(D + K)
 *   partitionEdge  O(D)
 *   snapshot       O(N·K + P)
 *   serialize      O(N·K)
 */

import {
  BEACON_RATIO,
  CLUSTER_LABELS,
  EPOCH_MS,
  GOSSIP_FANOUT,
  GOSSIP_PERIOD_RATIO,
  HELIXAR_SLACK_RATIO,
  HORIZON_FREEZE_SIGMA,
  KEY_COUNT,
  MAX_INFLIGHT,
  MAX_METRICS,
  NODE_COUNT,
  type Crystal,
  type CrystalId,
  type EdgeView,
  type EngineView,
  type HorizonView,
  type KeyId,
  type MeshEdge,
  type NeighborHorizon,
  type NodeId,
  type NodeView,
  type PacketView,
  type Protocol,
  type ReplicaNode,
  type TwinMetricsSample,
  type WakePacket,
} from "./types.ts";
import {
  cloneSketch,
  fingerprintStore,
  joinCrystal,
  makeHcc,
  makeRng,
  packCrystalId,
  packetBytes,
  sketchDecode,
  sketchFromIds,
} from "./primitives.ts";

export interface Engine {
  readonly protocol: Protocol;
  now: number;
  seq: number;
  nodes: ReplicaNode[];
  edges: MeshEdge[];
  adj: number[][];
  packets: WakePacket[];
  lastMutation: Crystal | null;
  pendingSince: number;
  lastConsistentAt: number;
  lastUnisonMs: number;
  bytes: number;
  wakes: number;
  rng: () => number;
  latencyScale: number;
  meanDelay: number;
}

export interface TwinEngine {
  helixar: Engine;
  gossip: Engine;
  samples: TwinMetricsSample[];
  autoMutate: boolean;
  autoEvery: number;
  nextAutoAt: number;
  selected: NodeId;
  selectedKey: KeyId;
  running: boolean;
  speed: number;
}

const CLUSTER_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0.22, 0.38],
  [0.5, 0.62],
  [0.78, 0.36],
];

function neighborHorizon(delay: number): NeighborHorizon {
  return {
    lastHeardAt: 0,
    ewmaDelay: delay,
    frozen: false,
    predictedIds: new Set<CrystalId>(),
    inflight: [],
  };
}

function buildTopology(rng: () => number): {
  nodes: ReplicaNode[];
  edges: MeshEdge[];
  adj: number[][];
} {
  const nodes: ReplicaNode[] = [];
  for (let id = 0; id < NODE_COUNT; id++) {
    const cluster = Math.floor(id / 4) as 0 | 1 | 2;
    const [ax, ay] = CLUSTER_ANCHORS[cluster]!;
    const angle = (id % 4) * (Math.PI / 2) + cluster * 0.2;
    const radius = 0.09 + rng() * 0.02;
    nodes.push({
      id,
      label: CLUSTER_LABELS[id]!,
      cluster,
      x: ax + Math.cos(angle) * radius,
      y: ay + Math.sin(angle) * radius * 0.92,
      epoch: 0,
      spin: 0,
      lastEpoch: 0,
      store: new Map(),
      horizons: [],
      slackUntil: [],
      slackBuffer: [],
      lastBeaconAt: -id * 37,
      lastGossipAt: -id * 53,
      lastSentAt: [],
      wakesSent: 0,
      bytesSent: 0,
      clockSkew: (rng() - 0.5) * 40,
    });
  }

  const edgeSet: MeshEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (a: number, b: number, delay: number) => {
    if (a === b) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}-${hi}`;
    if (seen.has(key)) return;
    seen.add(key);
    edgeSet.push({
      a: lo,
      b: hi,
      delay,
      baseDelay: delay,
      partitioned: false,
    });
  };

  for (let c = 0; c < 3; c++) {
    const base = c * 4;
    addEdge(base, base + 1, 90 + rng() * 40);
    addEdge(base + 1, base + 2, 90 + rng() * 40);
    addEdge(base + 2, base + 3, 90 + rng() * 40);
    addEdge(base + 3, base, 90 + rng() * 40);
    addEdge(base, base + 2, 120 + rng() * 30);
  }

  addEdge(2, 4, 720 + rng() * 280);
  addEdge(3, 5, 980 + rng() * 320);
  addEdge(6, 8, 640 + rng() * 260);
  addEdge(7, 9, 1100 + rng() * 400);
  addEdge(1, 11, 1480 + rng() * 320);
  addEdge(0, 8, 1680 + rng() * 280);

  const adj: number[][] = Array.from({ length: NODE_COUNT }, () => []);
  for (let i = 0; i < edgeSet.length; i++) {
    const e = edgeSet[i]!;
    adj[e.a]!.push(i);
    adj[e.b]!.push(i);
  }

  for (const node of nodes) {
    node.horizons = new Array(NODE_COUNT);
    node.slackUntil = new Array(NODE_COUNT).fill(0);
    node.slackBuffer = Array.from({ length: NODE_COUNT }, () => []);
    node.lastSentAt = new Array(NODE_COUNT).fill(-1_000_000);
    for (let j = 0; j < NODE_COUNT; j++) {
      const delay = edgeDelayBetween(edgeSet, adj, node.id, j) ?? 800;
      node.horizons[j] = neighborHorizon(delay);
    }
  }

  return { nodes, edges: edgeSet, adj };
}

function edgeDelayBetween(
  edges: MeshEdge[],
  adj: number[][],
  a: NodeId,
  b: NodeId,
): number | null {
  for (const ei of adj[a] ?? []) {
    const e = edges[ei]!;
    const other = e.a === a ? e.b : e.a;
    if (other === b) return e.delay;
  }
  return null;
}

function meanDelayOf(edges: MeshEdge[]): number {
  if (edges.length === 0) return 400;
  let s = 0;
  for (const e of edges) s += e.delay;
  return s / edges.length;
}

/** O(N·D + K) */
export function createEngine(
  protocol: Protocol,
  seed = 1,
  latencyScale = 1,
): Engine {
  const rng = makeRng(seed ^ (protocol === "helixar" ? 0x51ed : 0x905));
  const { nodes, edges, adj } = buildTopology(makeRng(seed));
  applyLatencyScale(edges, latencyScale);
  return {
    protocol,
    now: 0,
    seq: 1,
    nodes,
    edges,
    adj,
    packets: [],
    lastMutation: null,
    pendingSince: 0,
    lastConsistentAt: 0,
    lastUnisonMs: 0,
    bytes: 0,
    wakes: 0,
    rng,
    latencyScale,
    meanDelay: meanDelayOf(edges),
  };
}

function applyLatencyScale(edges: MeshEdge[], scale: number): void {
  const s = clamp(scale, 0.4, 5);
  for (const e of edges) e.delay = Math.max(40, e.baseDelay * s);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function otherEnd(edge: MeshEdge, id: NodeId): NodeId {
  return edge.a === id ? edge.b : edge.a;
}

function neighborsOf(engine: Engine, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  for (const ei of engine.adj[id] ?? []) {
    out.push(otherEnd(engine.edges[ei]!, id));
  }
  return out;
}

function findEdge(engine: Engine, a: NodeId, b: NodeId): MeshEdge | null {
  for (const ei of engine.adj[a] ?? []) {
    const e = engine.edges[ei]!;
    if (e.a === a && e.b === b) return e;
    if (e.a === b && e.b === a) return e;
  }
  return null;
}

function localEpoch(node: ReplicaNode, now: number): number {
  return Math.max(0, Math.floor((now + node.clockSkew) / EPOCH_MS));
}

function advanceClock(node: ReplicaNode, now: number): void {
  const epoch = localEpoch(node, now);
  node.epoch = Math.max(epoch, node.lastEpoch);
}

function storeIds(node: ReplicaNode): CrystalId[] {
  const ids: CrystalId[] = [];
  for (const c of node.store.values()) ids.push(c.id);
  return ids;
}

function harvestInflight(h: NeighborHorizon, now: number): void {
  if (h.inflight.length === 0) return;
  const keep: typeof h.inflight = [];
  for (const mark of h.inflight) {
    if (mark.eta <= now) {
      for (const id of mark.ids) h.predictedIds.add(id);
    } else {
      keep.push(mark);
    }
  }
  h.inflight = keep;
}

function predictedHas(h: NeighborHorizon, id: CrystalId, now: number): boolean {
  harvestInflight(h, now);
  if (h.predictedIds.has(id)) return true;
  for (const mark of h.inflight) {
    if (mark.ids.includes(id)) return true;
  }
  return false;
}

function missingFor(
  node: ReplicaNode,
  neighbor: NodeId,
  now: number,
): Crystal[] {
  const h = node.horizons[neighbor];
  if (!h) return [];
  harvestInflight(h, now);
  const missing: Crystal[] = [];
  for (const crystal of node.store.values()) {
    if (!predictedHas(h, crystal.id, now)) missing.push(crystal);
  }
  return missing;
}

function enqueuePacket(engine: Engine, packet: WakePacket): void {
  if (engine.packets.length >= MAX_INFLIGHT) {
    engine.packets.shift();
  }
  engine.packets.push(packet);
  engine.bytes += packet.bytes;
  engine.wakes += 1;
  const from = engine.nodes[packet.from]!;
  from.wakesSent += 1;
  from.bytesSent += packet.bytes;
}

function sendWake(
  engine: Engine,
  fromId: NodeId,
  toId: NodeId,
  crystals: readonly Crystal[],
  isBeacon: boolean,
): void {
  const edge = findEdge(engine, fromId, toId);
  if (!edge || edge.partitioned) return;
  const from = engine.nodes[fromId]!;
  const delay = edge.delay;
  const ids = crystals.map((c) => c.id);
  const packet: WakePacket = {
    seq: engine.seq++,
    protocol: engine.protocol,
    from: fromId,
    to: toId,
    sentAt: engine.now,
    arriveAt: engine.now + delay,
    crystals,
    sketch: sketchFromIds(storeIds(from)),
    isBeacon,
    bytes: packetBytes(crystals.length, isBeacon),
  };
  enqueuePacket(engine, packet);
  const h = from.horizons[toId]!;
  h.ewmaDelay = h.ewmaDelay * 0.8 + delay * 0.2;
  if (ids.length > 0) {
    h.inflight.push({ ids, eta: packet.arriveAt });
    if (h.inflight.length > 48) h.inflight.shift();
  }
  from.slackBuffer[toId] = [];
  from.slackUntil[toId] = engine.now + delay * HELIXAR_SLACK_RATIO;
  from.lastSentAt[toId] = engine.now;
  if (isBeacon) from.lastBeaconAt = engine.now;
}

function bufferOrSend(
  engine: Engine,
  fromId: NodeId,
  toId: NodeId,
  crystal: Crystal,
): void {
  const from = engine.nodes[fromId]!;
  const h = from.horizons[toId];
  if (!h || h.frozen) return;
  if (predictedHas(h, crystal.id, engine.now)) return;
  const buf = from.slackBuffer[toId]!;
  if (!buf.some((c) => c.id === crystal.id)) buf.push(crystal);
  const slack = from.slackUntil[toId] ?? 0;
  if (engine.now >= slack) {
    const batch = from.slackBuffer[toId]!;
    if (batch.length > 0) sendWake(engine, fromId, toId, batch.slice(), false);
  }
}

function mergeCrystal(node: ReplicaNode, crystal: Crystal): boolean {
  const prev = node.store.get(crystal.key);
  if (!prev) {
    node.store.set(crystal.key, crystal);
    return true;
  }
  const joined = joinCrystal(prev, crystal);
  if (joined.id === prev.id) return false;
  node.store.set(crystal.key, joined);
  return true;
}

function applySketchHint(
  node: ReplicaNode,
  fromId: NodeId,
  packet: WakePacket,
): void {
  const h = node.horizons[fromId];
  if (!h) return;
  h.lastHeardAt = packet.arriveAt;
  h.frozen = false;
  for (const c of packet.crystals) h.predictedIds.add(c.id);
  if (!packet.isBeacon) return;
  const decoded = sketchDecode(packet.sketch);
  if (!decoded.ok) return;
  const next = new Set<CrystalId>(decoded.ids);
  for (const mark of h.inflight) {
    if (mark.eta > packet.sentAt) {
      for (const id of mark.ids) next.add(id);
    }
  }
  h.predictedIds = next;
}

function diffract(engine: Engine, node: ReplicaNode, crystal: Crystal): void {
  if (engine.protocol !== "helixar") return;
  for (const nei of neighborsOf(engine, node.id)) {
    const edge = findEdge(engine, node.id, nei);
    if (!edge || edge.partitioned) continue;
    bufferOrSend(engine, node.id, nei, crystal);
  }
}

function deliver(engine: Engine, packet: WakePacket): void {
  const node = engine.nodes[packet.to]!;
  const fromH = node.horizons[packet.from];
  if (fromH) {
    fromH.lastHeardAt = engine.now;
    fromH.frozen = false;
    const oneWay = packet.arriveAt - packet.sentAt;
    fromH.ewmaDelay = fromH.ewmaDelay * 0.75 + oneWay * 0.25;
  }

  const changed: Crystal[] = [];
  for (const crystal of packet.crystals) {
    if (mergeCrystal(node, crystal)) changed.push(crystal);
  }

  if (engine.protocol === "helixar") {
    applySketchHint(node, packet.from, packet);
    for (const crystal of changed) diffract(engine, node, crystal);
    if (packet.isBeacon) {
      const missing = missingFor(node, packet.from, engine.now);
      if (missing.length > 0) {
        sendWake(engine, node.id, packet.from, missing, false);
      }
    }
    return;
  }

  if (changed.length === 0) return;
  const nei = neighborsOf(engine, node.id).filter((id) => id !== packet.from);
  shuffleInPlace(nei, engine.rng);
  const fanout = Math.min(GOSSIP_FANOUT, nei.length);
  for (let i = 0; i < fanout; i++) {
    const target = nei[i]!;
    const edge = findEdge(engine, node.id, target);
    if (!edge || edge.partitioned) continue;
    sendWake(engine, node.id, target, changed, false);
  }
}

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

function freezeSilent(engine: Engine): void {
  for (const node of engine.nodes) {
    for (const nei of neighborsOf(engine, node.id)) {
      const h = node.horizons[nei]!;
      const edge = findEdge(engine, node.id, nei);
      if (!edge) continue;
      if (edge.partitioned) {
        h.frozen = true;
        continue;
      }
      const timeout = h.ewmaDelay * HORIZON_FREEZE_SIGMA + 120;
      if (h.lastHeardAt > 0 && engine.now - h.lastHeardAt > timeout) {
        h.frozen = true;
      }
    }
  }
}

function flushSlack(engine: Engine): void {
  if (engine.protocol !== "helixar") return;
  for (const node of engine.nodes) {
    for (const nei of neighborsOf(engine, node.id)) {
      const buf = node.slackBuffer[nei]!;
      const due = node.slackUntil[nei] ?? 0;
      if (buf.length > 0 && engine.now >= due) {
        sendWake(engine, node.id, nei, buf.slice(), false);
      }
    }
  }
}

function emitBeacons(engine: Engine): void {
  if (engine.protocol !== "helixar") return;
  for (const node of engine.nodes) {
    for (const nei of neighborsOf(engine, node.id)) {
      const edge = findEdge(engine, node.id, nei);
      if (!edge || edge.partitioned) continue;
      const lastSent = node.lastSentAt[nei] ?? -1_000_000;
      const period = edge.delay * BEACON_RATIO + 280;
      if (engine.now - lastSent < period) continue;
      const missing = missingFor(node, nei, engine.now);
      if (missing.length === 0 && engine.now < period) continue;
      sendWake(engine, node.id, nei, missing, true);
    }
  }
}

function gossipAntiEntropy(engine: Engine): void {
  if (engine.protocol !== "gossip") return;
  const period = engine.meanDelay * GOSSIP_PERIOD_RATIO;
  for (const node of engine.nodes) {
    if (engine.now - node.lastGossipAt < period) continue;
    node.lastGossipAt = engine.now;
    const nei = neighborsOf(engine, node.id);
    if (nei.length === 0) continue;
    const target = nei[Math.floor(engine.rng() * nei.length)]!;
    const edge = findEdge(engine, node.id, target);
    if (!edge || edge.partitioned) continue;
    const crystals = [...node.store.values()];
    sendWake(engine, node.id, target, crystals, true);
  }
}

function divergenceOf(engine: Engine): number {
  let div = 0;
  for (let k = 0; k < KEY_COUNT; k++) {
    let first: Crystal | null | undefined;
    let disagree = false;
    for (const node of engine.nodes) {
      const c = node.store.get(k) ?? null;
      if (first === undefined) {
        first = c;
        continue;
      }
      if (first === null) {
        if (c !== null) {
          disagree = true;
          break;
        }
      } else if (!c || c.id !== first.id) {
        disagree = true;
        break;
      }
    }
    if (disagree) div += 1;
  }
  return div;
}

function recomputeConsistency(engine: Engine): void {
  const div = divergenceOf(engine);
  if (div === 0) {
    if (engine.lastConsistentAt < 0) {
      engine.lastUnisonMs = Math.max(0, engine.now - engine.pendingSince);
    }
    engine.lastConsistentAt = engine.now;
  }
}

/** Advance simulated time. O(P + N·D·K) */
export function step(engine: Engine, dtMs: number): void {
  const dt = Math.max(0, dtMs);
  if (dt === 0) return;
  engine.now += dt;
  for (const node of engine.nodes) advanceClock(node, engine.now);

  const due: WakePacket[] = [];
  const later: WakePacket[] = [];
  for (const p of engine.packets) {
    if (p.arriveAt <= engine.now) due.push(p);
    else later.push(p);
  }
  due.sort((a, b) => a.arriveAt - b.arriveAt || a.seq - b.seq);
  engine.packets = later;
  for (const packet of due) deliver(engine, packet);

  freezeSilent(engine);
  flushSlack(engine);
  emitBeacons(engine);
  gossipAntiEntropy(engine);
  recomputeConsistency(engine);
}

/** Local mutation + wake emission. O(D + K) */
export function mutate(
  engine: Engine,
  nodeId: NodeId,
  key: KeyId,
  payload: number,
): Crystal | null {
  if (nodeId < 0 || nodeId >= engine.nodes.length) return null;
  if (key < 0 || key >= KEY_COUNT) return null;
  const node = engine.nodes[nodeId]!;
  advanceClock(node, engine.now);
  node.spin += 1;
  node.lastEpoch = node.epoch;
  const crystal: Crystal = {
    id: packCrystalId(node.id, node.spin),
    hcc: makeHcc(node.id, node.epoch, node.spin),
    key,
    payload: payload >>> 0,
  };
  node.store.set(key, crystal);
  engine.lastMutation = crystal;
  engine.pendingSince = engine.now;
  engine.lastConsistentAt = -1;
  if (engine.protocol === "helixar") {
    diffract(engine, node, crystal);
  } else {
    const nei = neighborsOf(engine, node.id);
    shuffleInPlace(nei, engine.rng);
    const fanout = Math.min(GOSSIP_FANOUT, nei.length);
    for (let i = 0; i < fanout; i++) {
      const target = nei[i]!;
      const edge = findEdge(engine, node.id, target);
      if (!edge || edge.partitioned) continue;
      sendWake(engine, node.id, target, [crystal], false);
    }
  }
  recomputeConsistency(engine);
  return crystal;
}

/** Toggle a bidirectional link. Frozen horizons snap on heal. O(D) */
export function partitionEdge(
  engine: Engine,
  a: NodeId,
  b: NodeId,
  partitioned?: boolean,
): boolean {
  const edge = findEdge(engine, a, b);
  if (!edge) return false;
  edge.partitioned = partitioned ?? !edge.partitioned;
  if (!edge.partitioned) {
    const na = engine.nodes[a]!;
    const nb = engine.nodes[b]!;
    na.horizons[b]!.frozen = false;
    nb.horizons[a]!.frozen = false;
    na.horizons[b]!.lastHeardAt = engine.now;
    nb.horizons[a]!.lastHeardAt = engine.now;
    if (engine.protocol === "helixar") {
      const missA = missingFor(na, b, engine.now);
      const missB = missingFor(nb, a, engine.now);
      if (missA.length > 0) sendWake(engine, a, b, missA, true);
      if (missB.length > 0) sendWake(engine, b, a, missB, true);
    } else {
      sendWake(engine, a, b, [...na.store.values()], true);
      sendWake(engine, b, a, [...nb.store.values()], true);
    }
  } else {
    engine.packets = engine.packets.filter(
      (p) =>
        !((p.from === a && p.to === b) || (p.from === b && p.to === a)),
    );
    engine.nodes[a]!.horizons[b]!.frozen = true;
    engine.nodes[b]!.horizons[a]!.frozen = true;
    engine.nodes[a]!.horizons[b]!.inflight = [];
    engine.nodes[b]!.horizons[a]!.inflight = [];
  }
  recomputeConsistency(engine);
  return edge.partitioned;
}

export function healAll(engine: Engine): void {
  for (const e of engine.edges) {
    if (e.partitioned) partitionEdge(engine, e.a, e.b, false);
  }
}

export function setLatencyScale(engine: Engine, scale: number): void {
  engine.latencyScale = clamp(scale, 0.4, 5);
  applyLatencyScale(engine.edges, engine.latencyScale);
  engine.meanDelay = meanDelayOf(engine.edges);
  for (const node of engine.nodes) {
    for (const nei of neighborsOf(engine, node.id)) {
      const d = findEdge(engine, node.id, nei)?.delay ?? 800;
      node.horizons[nei]!.ewmaDelay = d;
    }
  }
}

function ttcOf(engine: Engine): number {
  if (divergenceOf(engine) === 0 && engine.lastMutation) {
    return Math.max(0, engine.lastConsistentAt - engine.pendingSince);
  }
  return engine.lastUnisonMs;
}

function horizonViews(engine: Engine, nodeId: NodeId): HorizonView[] {
  const node = engine.nodes[nodeId];
  if (!node) return [];
  const views: HorizonView[] = [];
  for (const nei of neighborsOf(engine, nodeId)) {
    const h = node.horizons[nei]!;
    harvestInflight(h, engine.now);
    views.push({
      neighbor: nei,
      delay: findEdge(engine, nodeId, nei)?.delay ?? 0,
      frozen: h.frozen,
      predicted: h.predictedIds.size,
      inflight: h.inflight.reduce((n, m) => n + m.ids.length, 0),
    });
  }
  return views;
}

/** Immutable render snapshot. O(N·K + P) */
export function snapshot(engine: Engine, selected: NodeId): EngineView {
  const nodes: NodeView[] = engine.nodes.map((n) => {
    const values: number[] = [];
    const authors: NodeId[] = [];
    for (let k = 0; k < KEY_COUNT; k++) {
      const c = n.store.get(k);
      values.push(c ? c.payload : -1);
      authors.push(c ? c.hcc.author : -1);
    }
    let frozen = 0;
    for (const nei of neighborsOf(engine, n.id)) {
      if (n.horizons[nei]!.frozen) frozen += 1;
    }
    return {
      id: n.id,
      label: n.label,
      cluster: n.cluster,
      x: n.x,
      y: n.y,
      epoch: n.epoch,
      spin: n.spin,
      fingerprint: fingerprintStore(n.store),
      frozen,
      wakesSent: n.wakesSent,
      bytesSent: n.bytesSent,
      values,
      authors,
    };
  });
  const edges: EdgeView[] = engine.edges.map((e) => ({
    a: e.a,
    b: e.b,
    delay: e.delay,
    partitioned: e.partitioned,
  }));
  const packets: PacketView[] = engine.packets.map((p) => {
    const span = Math.max(1, p.arriveAt - p.sentAt);
    return {
      seq: p.seq,
      protocol: p.protocol,
      from: p.from,
      to: p.to,
      progress: clamp((engine.now - p.sentAt) / span, 0, 1),
      crystalCount: p.crystals.length,
      isBeacon: p.isBeacon,
    };
  });
  const div = divergenceOf(engine);
  return {
    protocol: engine.protocol,
    now: engine.now,
    nodes,
    edges,
    packets,
    consistent: div === 0,
    divergence: div,
    bytes: engine.bytes,
    wakes: engine.wakes,
    inflight: engine.packets.length,
    ttc: ttcOf(engine),
    lastMutation: engine.lastMutation,
    selectedHorizon: horizonViews(engine, selected),
  };
}

export function createTwin(seed = 7, latencyScale = 1.6): TwinEngine {
  const helixar = createEngine("helixar", seed, latencyScale);
  const gossip = createEngine("gossip", seed, latencyScale);
  return {
    helixar,
    gossip,
    samples: [],
    autoMutate: true,
    autoEvery: 900,
    nextAutoAt: 400,
    selected: 0,
    selectedKey: 0,
    running: true,
    speed: 3.2,
  };
}

export function twinStep(twin: TwinEngine, dtMs: number): void {
  step(twin.helixar, dtMs);
  step(twin.gossip, dtMs);
  if (twin.autoMutate && twin.helixar.now >= twin.nextAutoAt) {
    const rng = twin.helixar.rng;
    const nodeId = Math.floor(rng() * NODE_COUNT);
    const key = twin.selectedKey;
    const payload = (Math.floor(rng() * 0xffffff) + 1) >>> 0;
    mutate(twin.helixar, nodeId, key, payload);
    mutate(twin.gossip, nodeId, key, payload);
    twin.selected = nodeId;
    twin.nextAutoAt = twin.helixar.now + twin.autoEvery * (0.6 + rng() * 0.8);
  }
  if (twin.samples.length >= MAX_METRICS) twin.samples.shift();
  twin.samples.push({
    t: twin.helixar.now,
    helixarTtc: ttcOf(twin.helixar),
    gossipTtc: ttcOf(twin.gossip),
    helixarBytes: twin.helixar.bytes,
    gossipBytes: twin.gossip.bytes,
    helixarDiv: divergenceOf(twin.helixar),
    gossipDiv: divergenceOf(twin.gossip),
  });
}

export function twinMutate(
  twin: TwinEngine,
  nodeId: NodeId,
  key: KeyId,
  payload: number,
): void {
  mutate(twin.helixar, nodeId, key, payload);
  mutate(twin.gossip, nodeId, key, payload);
  twin.selected = nodeId;
  twin.selectedKey = key;
}

export function twinPartition(twin: TwinEngine, a: NodeId, b: NodeId): void {
  partitionEdge(twin.helixar, a, b);
  partitionEdge(twin.gossip, a, b);
}

export function twinHeal(twin: TwinEngine): void {
  healAll(twin.helixar);
  healAll(twin.gossip);
}

export function twinSetLatency(twin: TwinEngine, scale: number): void {
  setLatencyScale(twin.helixar, scale);
  setLatencyScale(twin.gossip, scale);
}

export function twinReset(
  twin: TwinEngine,
  seed?: number,
  latencyScale?: number,
): TwinEngine {
  return createTwin(
    seed ?? Math.floor(twin.helixar.rng() * 1_000_000),
    latencyScale ?? twin.helixar.latencyScale,
  );
}

export function cloneViewSketch(engine: Engine, nodeId: NodeId) {
  const node = engine.nodes[nodeId];
  if (!node) return null;
  return cloneSketch(sketchFromIds(storeIds(node)));
}
