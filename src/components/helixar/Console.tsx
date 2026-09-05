import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MeshCanvas } from "@/components/helixar/MeshCanvas";
import { ControlDeck } from "@/components/helixar/ControlDeck";
import { Telemetry } from "@/components/helixar/Telemetry";
import {
  createTwin,
  snapshot,
  twinHeal,
  twinMutate,
  twinPartition,
  twinReset,
  twinSetLatency,
  twinStep,
  type EngineView,
  type KeyId,
  type NodeId,
  type Protocol,
  type TwinEngine,
} from "@/lib/helixar";

export function Console() {
  const twinRef = useRef<TwinEngine | null>(null);
  if (twinRef.current === null) twinRef.current = createTwin(7, 1.6);
  const twin = twinRef.current;

  const [protocol, setProtocol] = useState<Protocol>("helixar");
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(3.2);
  const [latency, setLatency] = useState(1.6);
  const [tick, setTick] = useState(0);
  const payloadRef = useRef(0x51e0);
  const protocolRef = useRef(protocol);
  protocolRef.current = protocol;

  twin.running = running;
  twin.speed = speed;

  const helixarView: EngineView = useMemo(
    () => snapshot(twin.helixar, twin.selected),
    [tick, twin],
  );
  const gossipView: EngineView = useMemo(
    () => snapshot(twin.gossip, twin.selected),
    [tick, twin],
  );
  const selectedLabel = helixarView.nodes[twin.selected]?.label ?? "R0";

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const loop = (t: number) => {
      const realDt = Math.min(48, t - last);
      last = t;
      const eng = twinRef.current!;
      if (eng.running) twinStep(eng, realDt * eng.speed);
      acc += realDt;
      if (acc > 140) {
        acc = 0;
        setTick((n) => n + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const getView = useCallback(
    () =>
      snapshot(
        protocolRef.current === "helixar"
          ? twinRef.current!.helixar
          : twinRef.current!.gossip,
        twinRef.current!.selected,
      ),
    [],
  );

  const inject = (id?: NodeId) => {
    const nodeId = id ?? twin.selected;
    payloadRef.current = (payloadRef.current + 17) >>> 0;
    twinMutate(twin, nodeId, twin.selectedKey, payloadRef.current || 1);
    setTick((n) => n + 1);
  };

  const cutBridges = () => {
    const bridges: Array<[number, number]> = [
      [2, 4],
      [3, 5],
      [6, 8],
      [7, 9],
      [1, 11],
      [0, 8],
    ];
    for (const [a, b] of bridges) twinPartition(twin, a, b);
    setTick((n) => n + 1);
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-[1400px] flex-col gap-4 px-4 py-4 md:gap-5 md:px-6 md:py-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <p className="font-mono text-[11px] font-medium tracking-[0.22em] text-muted uppercase">
            PHCS · mesh unison
          </p>
          <h1 className="mt-1 text-3xl font-medium tracking-[-0.03em] md:text-4xl">
            Helixar
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
            Predictive horizon sync. Click a node to select, double-click to
            mutate, click a link to partition. Wakes travel one-way — no RTT gate.
          </p>
        </div>
        <div className="flex items-center gap-3 font-mono text-[11px] tracking-wider text-muted uppercase">
          <span className={viewClass(helixarView, gossipView, protocol)}>
            {activeView(helixarView, gossipView, protocol).consistent
              ? "Unison"
              : "Divergent"}
          </span>
          <span className="text-subtle">/</span>
          <span className="tabular-nums text-fg">
            {activeView(helixarView, gossipView, protocol).inflight} in flight
          </span>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="overflow-hidden rounded-xl bg-surface shadow-[var(--shadow-border)]">
          <MeshCanvas
            getView={getView}
            selected={twin.selected}
            onSelect={(id) => {
              twin.selected = id;
              setTick((n) => n + 1);
            }}
            onInject={(id) => inject(id)}
            onPartition={(a, b) => {
              twinPartition(twin, a, b);
              setTick((n) => n + 1);
            }}
          />
        </div>
        <div className="flex flex-col gap-4">
          <ControlDeck
            protocol={protocol}
            running={running}
            autoMutate={twin.autoMutate}
            speed={speed}
            latency={latency}
            selectedKey={twin.selectedKey}
            selectedLabel={selectedLabel}
            onProtocol={setProtocol}
            onToggleRun={() => {
              twin.running = !twin.running;
              setRunning(twin.running);
            }}
            onToggleAuto={() => {
              twin.autoMutate = !twin.autoMutate;
              setTick((n) => n + 1);
            }}
            onSpeed={(v) => {
              twin.speed = v;
              setSpeed(v);
            }}
            onLatency={(v) => {
              setLatency(v);
              twinSetLatency(twin, v);
              setTick((n) => n + 1);
            }}
            onKey={(k: KeyId) => {
              twin.selectedKey = k;
              setTick((n) => n + 1);
            }}
            onInject={() => inject()}
            onCutBridges={cutBridges}
            onHeal={() => {
              twinHeal(twin);
              setTick((n) => n + 1);
            }}
            onReset={() => {
              twinRef.current = twinReset(twin, undefined, latency);
              twinRef.current.speed = speed;
              twinRef.current.running = running;
              setTick((n) => n + 1);
            }}
          />
          <Telemetry
            view={helixarView}
            gossip={gossipView}
            samples={twin.samples}
          />
        </div>
      </div>
    </div>
  );
}

function activeView(
  helixar: EngineView,
  gossip: EngineView,
  protocol: Protocol,
): EngineView {
  return protocol === "helixar" ? helixar : gossip;
}

function viewClass(
  helixar: EngineView,
  gossip: EngineView,
  protocol: Protocol,
): string {
  return activeView(helixar, gossip, protocol).consistent
    ? "text-ok"
    : "text-warn";
}