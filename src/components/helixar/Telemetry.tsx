import { KEY_NAMES, type EngineView, type TwinMetricsSample } from "@/lib/helixar";
import { cn } from "@/lib/utils";

type Props = {
  view: EngineView;
  gossip: EngineView;
  samples: readonly TwinMetricsSample[];
};

function fmtMs(n: number): string {
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function Spark({
  samples,
  a,
  b,
  labelA,
  labelB,
}: {
  samples: readonly TwinMetricsSample[];
  a: (s: TwinMetricsSample) => number;
  b: (s: TwinMetricsSample) => number;
  labelA: string;
  labelB: string;
}) {
  const w = 280;
  const h = 64;
  const pad = 4;
  if (samples.length < 2) {
    return (
      <div className="h-16 rounded-md bg-elevated" />
    );
  }
  const va = samples.map(a);
  const vb = samples.map(b);
  const max = Math.max(1, ...va, ...vb);
  const path = (vals: number[]) =>
    vals
      .map((v, i) => {
        const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
        const y = h - pad - (v / max) * (h - pad * 2);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full text-signal">
        <path d={path(vb)} fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.25" />
        <path d={path(va)} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] tracking-wider text-muted uppercase">
        <span>{labelA}</span>
        <span className="opacity-60">{labelB}</span>
      </div>
    </div>
  );
}

export function Telemetry({ view, gossip, samples }: Props) {
  const stats = [
    { k: "TTC", a: fmtMs(view.ttc), b: fmtMs(gossip.ttc) },
    { k: "Bytes", a: fmtBytes(view.bytes), b: fmtBytes(gossip.bytes) },
    { k: "Wakes", a: String(view.wakes), b: String(gossip.wakes) },
    { k: "Div", a: String(view.divergence), b: String(gossip.divergence) },
  ];

  return (
    <section className="flex flex-col gap-5 rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] md:p-5">
      <header>
        <p className="font-mono text-[11px] font-medium tracking-[0.18em] text-muted uppercase">
          Telemetry
        </p>
        <h2 className="mt-1 text-base font-medium tracking-tight">
          Helixar vs epidemic gossip
        </h2>
      </header>

      <div className="grid grid-cols-2 gap-2">
        {stats.map((s) => (
          <div
            key={s.k}
            className="rounded-md bg-elevated px-3 py-2.5"
          >
            <p className="font-mono text-[10px] tracking-wider text-muted uppercase">{s.k}</p>
            <p className="mt-1 font-mono text-sm tabular-nums text-fg">{s.a}</p>
            <p className="font-mono text-[11px] tabular-nums text-muted">{s.b} gossip</p>
          </div>
        ))}
      </div>

      <Spark
        samples={samples}
        a={(s) => s.helixarTtc}
        b={(s) => s.gossipTtc}
        labelA="Helixar TTC"
        labelB="Gossip TTC"
      />

      <div>
        <p className="mb-2 font-mono text-[11px] tracking-wider text-muted uppercase">
          Horizon · selected
        </p>
        <ul className="flex flex-col gap-1">
          {view.selectedHorizon.map((h) => (
            <li
              key={h.neighbor}
              className="flex items-center justify-between rounded-sm bg-elevated px-2.5 py-2 font-mono text-[11px] tabular-nums"
            >
              <span className="text-muted">N{h.neighbor}</span>
              <span className={cn(h.frozen ? "text-warn" : "text-fg")}>
                {Math.round(h.delay)}ms · pred {h.predicted}
                {h.frozen ? " · FROZEN" : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="mb-2 font-mono text-[11px] tracking-wider text-muted uppercase">
          Register map · {view.nodes[0] ? "cluster unison" : ""}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[280px] border-collapse text-left font-mono text-[10px]">
            <thead>
              <tr className="text-muted">
                <th className="pb-1 font-medium">Node</th>
                {KEY_NAMES.map((k) => (
                  <th key={k} className="pb-1 font-medium">
                    {k}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.nodes.map((n) => (
                <tr key={n.id} className="text-fg">
                  <td className="py-0.5 text-muted">{n.label}</td>
                  {n.values.map((val, i) => (
                    <td key={i} className="py-0.5 tabular-nums">
                      {val < 0 ? "—" : (val % 256).toString(16).padStart(2, "0")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
