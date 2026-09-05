import {
  Activity,
  Gauge,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Split,
  Unplug,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { KEY_NAMES, type KeyId, type Protocol } from "@/lib/helixar";
import { cn } from "@/lib/utils";

type Props = {
  protocol: Protocol;
  running: boolean;
  autoMutate: boolean;
  speed: number;
  latency: number;
  selectedKey: KeyId;
  selectedLabel: string;
  onProtocol: (p: Protocol) => void;
  onToggleRun: () => void;
  onToggleAuto: () => void;
  onSpeed: (v: number) => void;
  onLatency: (v: number) => void;
  onKey: (k: KeyId) => void;
  onInject: () => void;
  onCutBridges: () => void;
  onHeal: () => void;
  onReset: () => void;
};

export function ControlDeck({
  protocol,
  running,
  autoMutate,
  speed,
  latency,
  selectedKey,
  selectedLabel,
  onProtocol,
  onToggleRun,
  onToggleAuto,
  onSpeed,
  onLatency,
  onKey,
  onInject,
  onCutBridges,
  onHeal,
  onReset,
}: Props) {
  return (
    <section className="flex flex-col gap-5 rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] md:p-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] font-medium tracking-[0.18em] text-muted uppercase">
            Control deck
          </p>
          <h2 className="mt-1 text-base font-medium tracking-tight">
            Node {selectedLabel}
          </h2>
        </div>
        <div className="flex rounded-md bg-elevated p-1 shadow-[var(--shadow-border)]">
          {(["helixar", "gossip"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onProtocol(p)}
              className={cn(
                "h-9 rounded-sm px-3 font-mono text-[11px] font-medium tracking-wide uppercase transition-colors duration-150",
                protocol === p
                  ? "bg-primary text-primary-fg"
                  : "text-muted hover:text-fg",
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant={running ? "secondary" : "default"}
          onClick={onToggleRun}
        >
          {running ? <Pause /> : <Play />}
          {running ? "Pause" : "Run"}
        </Button>
        <Button type="button" variant="secondary" onClick={onInject}>
          <Zap />
          Inject
        </Button>
        <Button type="button" variant="outline" onClick={onCutBridges}>
          <Unplug />
          Cut bridges
        </Button>
        <Button type="button" variant="outline" onClick={onHeal}>
          <Split />
          Heal mesh
        </Button>
      </div>

      <button
        type="button"
        onClick={onToggleAuto}
        className={cn(
          "flex h-11 items-center justify-between rounded-md px-3 text-sm transition-colors duration-150",
          autoMutate ? "bg-elevated text-fg" : "bg-transparent text-muted",
        )}
        style={{ boxShadow: "var(--shadow-border)" }}
      >
        <span className="flex items-center gap-2">
          <Activity className="size-4" />
          Auto traffic
        </span>
        <span className="font-mono text-[11px] tracking-wider uppercase">
          {autoMutate ? "On" : "Off"}
        </span>
      </button>

      <label className="flex flex-col gap-2">
        <span className="flex items-center justify-between font-mono text-[11px] tracking-wider text-muted uppercase">
          <span className="flex items-center gap-1.5">
            <Gauge className="size-3.5" /> Sim speed
          </span>
          <span className="tabular-nums text-fg">{speed.toFixed(1)}×</span>
        </span>
        <input
          type="range"
          min={0.5}
          max={8}
          step={0.1}
          value={speed}
          onChange={(e) => onSpeed(Number(e.target.value))}
          className="h-11 w-full accent-primary"
        />
      </label>

      <label className="flex flex-col gap-2">
        <span className="flex items-center justify-between font-mono text-[11px] tracking-wider text-muted uppercase">
          <span className="flex items-center gap-1.5">
            <Radio className="size-3.5" /> Latency scale
          </span>
          <span className="tabular-nums text-fg">{latency.toFixed(1)}×</span>
        </span>
        <input
          type="range"
          min={0.5}
          max={4}
          step={0.1}
          value={latency}
          onChange={(e) => onLatency(Number(e.target.value))}
          className="h-11 w-full accent-primary"
        />
      </label>

      <div>
        <p className="mb-2 font-mono text-[11px] tracking-wider text-muted uppercase">
          Register
        </p>
        <div className="grid grid-cols-4 gap-1.5">
          {KEY_NAMES.map((name, i) => (
            <button
              key={name}
              type="button"
              onClick={() => onKey(i)}
              className={cn(
                "h-11 rounded-sm font-mono text-[11px] font-medium tracking-wide transition-colors duration-150",
                selectedKey === i
                  ? "bg-primary text-primary-fg"
                  : "bg-elevated text-muted hover:text-fg",
              )}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      <Button type="button" variant="ghost" onClick={onReset} className="self-start px-2">
        <RotateCcw />
        Reset mesh
      </Button>
    </section>
  );
}
