/**
 * Helixar — Predictive Horizon Crystal Sync (PHCS)
 *
 * A one-way, topology-aware replica protocol for high-latency mesh networks.
 * Causality is a helical coordinate; missing state is a sketch difference;
 * delivery is a predicted horizon, never an RTT-gated handshake.
 */

export const NODE_COUNT = 12;
export const KEY_COUNT = 8;
export const SKETCH_CELLS = 32;
export const BLOOM_WORDS = 8;
export const MAX_INFLIGHT = 384;
export const MAX_METRICS = 240;
export const EPOCH_MS = 1_000;
export const HELIXAR_SLACK_RATIO = 0.06;
export const GOSSIP_FANOUT = 2;
export const GOSSIP_PERIOD_RATIO = 2.4;
export const BEACON_RATIO = 5.4;
export const HORIZON_FREEZE_SIGMA = 3.2;

export const KEY_NAMES = [
  "NAV",
  "FIX",
  "LOG",
  "TEL",
  "ENV",
  "QOS",
  "ACK",
  "MAP",
] as const;

export const CLUSTER_LABELS = [
  "R0",
  "R1",
  "R2",
  "R3",
  "B0",
  "B1",
  "B2",
  "B3",
  "S0",
  "S1",
  "S2",
  "S3",
] as const;

export type Protocol = "helixar" | "gossip";
export type NodeId = number;
export type KeyId = number;
export type CrystalId = number;

export interface HelicalCausalCoordinate {
  readonly author: NodeId;
  readonly epoch: number;
  readonly spin: number;
  readonly phase: number;
}

export interface Crystal {
  readonly id: CrystalId;
  readonly hcc: HelicalCausalCoordinate;
  readonly key: KeyId;
  readonly payload: number;
}

export interface SketchCell {
  count: number;
  xorId: number;
  xorHash: number;
}

export interface CrystalSketch {
  readonly cells: SketchCell[];
}

export interface NeighborHorizon {
  lastHeardAt: number;
  ewmaDelay: number;
  frozen: boolean;
  predictedIds: Set<CrystalId>;
  inflight: InflightMark[];
}

export interface InflightMark {
  readonly ids: readonly CrystalId[];
  readonly eta: number;
}

export interface MeshEdge {
  readonly a: NodeId;
  readonly b: NodeId;
  delay: number;
  baseDelay: number;
  partitioned: boolean;
}

export interface WakePacket {
  readonly seq: number;
  readonly protocol: Protocol;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly sentAt: number;
  readonly arriveAt: number;
  readonly crystals: readonly Crystal[];
  readonly sketch: CrystalSketch;
  readonly isBeacon: boolean;
  readonly bytes: number;
}

export interface ReplicaNode {
  readonly id: NodeId;
  readonly label: string;
  readonly cluster: 0 | 1 | 2;
  readonly x: number;
  readonly y: number;
  epoch: number;
  spin: number;
  lastEpoch: number;
  store: Map<KeyId, Crystal>;
  horizons: NeighborHorizon[];
  slackUntil: number[];
  slackBuffer: Crystal[][];
  lastBeaconAt: number;
  lastGossipAt: number;
  lastSentAt: number[];
  wakesSent: number;
  bytesSent: number;
  clockSkew: number;
}

export interface EngineMetrics {
  now: number;
  consistent: boolean;
  divergence: number;
  bytesHelixar: number;
  bytesGossip: number;
  wakesHelixar: number;
  wakesGossip: number;
  inflightHelixar: number;
  inflightGossip: number;
  ttcHelixar: number;
  ttcGossip: number;
  pendingSince: number;
}

export interface NodeView {
  readonly id: NodeId;
  readonly label: string;
  readonly cluster: 0 | 1 | 2;
  readonly x: number;
  readonly y: number;
  readonly epoch: number;
  readonly spin: number;
  readonly fingerprint: number;
  readonly frozen: number;
  readonly wakesSent: number;
  readonly bytesSent: number;
  readonly values: readonly number[];
  readonly authors: readonly NodeId[];
}

export interface EdgeView {
  readonly a: NodeId;
  readonly b: NodeId;
  readonly delay: number;
  readonly partitioned: boolean;
}

export interface PacketView {
  readonly seq: number;
  readonly protocol: Protocol;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly progress: number;
  readonly crystalCount: number;
  readonly isBeacon: boolean;
}

export interface EngineView {
  readonly protocol: Protocol;
  readonly now: number;
  readonly nodes: readonly NodeView[];
  readonly edges: readonly EdgeView[];
  readonly packets: readonly PacketView[];
  readonly consistent: boolean;
  readonly divergence: number;
  readonly bytes: number;
  readonly wakes: number;
  readonly inflight: number;
  readonly ttc: number;
  readonly lastMutation: Crystal | null;
  readonly selectedHorizon: readonly HorizonView[];
}

export interface HorizonView {
  readonly neighbor: NodeId;
  readonly delay: number;
  readonly frozen: boolean;
  readonly predicted: number;
  readonly inflight: number;
}

export interface TwinMetricsSample {
  readonly t: number;
  readonly helixarTtc: number;
  readonly gossipTtc: number;
  readonly helixarBytes: number;
  readonly gossipBytes: number;
  readonly helixarDiv: number;
  readonly gossipDiv: number;
}
