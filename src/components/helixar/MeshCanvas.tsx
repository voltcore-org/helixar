import { useEffect, useRef } from "react";
import type { EngineView, NodeId } from "@/lib/helixar";

type Props = {
  getView: () => EngineView;
  selected: NodeId;
  onSelect: (id: NodeId) => void;
  onInject: (id: NodeId) => void;
  onPartition: (a: NodeId, b: NodeId) => void;
};

type Hit =
  | { kind: "node"; id: NodeId }
  | { kind: "edge"; a: NodeId; b: NodeId };

function token(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

function replicaFill(fp: number, empty: boolean): string {
  if (empty) return "rgba(236,236,232,0.12)";
  const h = 188 + (fp % 28);
  const s = 16 + (fp % 10);
  const l = 48 + (fp % 10);
  return `hsl(${h} ${s}% ${l}%)`;
}

export function MeshCanvas({
  getView,
  selected,
  onSelect,
  onInject,
  onPartition,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const getViewRef = useRef(getView);
  const selectedRef = useRef(selected);
  getViewRef.current = getView;
  selectedRef.current = selected;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let disposed = false;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const layout = (w: number, h: number) => {
      const padX = 36;
      const padY = 32;
      return {
        padX,
        padY,
        innerW: w - padX * 2,
        innerH: h - padY * 2,
        mapX: (x: number) => padX + x * (w - padX * 2),
        mapY: (y: number) => padY + y * (h - padY * 2),
      };
    };

    const paint = () => {
      if (disposed) return;
      const rect = wrap.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const v = getViewRef.current();
      const sel = selectedRef.current;
      const bg = token(wrap, "--color-bg", "#090a0c");
      const fg = token(wrap, "--color-fg", "#ecece8");
      const muted = token(wrap, "--color-muted", "#8a8d92");
      const subtle = token(wrap, "--color-subtle", "#5c6066");
      const signal = token(wrap, "--color-signal", "#8aa4b0");
      const warn = token(wrap, "--color-warn", "#b08968");
      const { mapX, mapY } = layout(w, h);

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = "rgba(236,236,232,0.05)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 8; i++) {
        const x = (w / 8) * i;
        const y = (h / 6) * i;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        if (i < 6) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
      }

      ctx.strokeStyle = "rgba(236,236,232,0.16)";
      ctx.strokeRect(10.5, 10.5, w - 21, h - 21);
      ctx.strokeStyle = "rgba(236,236,232,0.08)";
      ctx.strokeRect(16.5, 16.5, w - 33, h - 33);

      const corner = (x: number, y: number, dx: number, dy: number) => {
        ctx.beginPath();
        ctx.moveTo(x, y + dy * 12);
        ctx.lineTo(x, y);
        ctx.lineTo(x + dx * 12, y);
        ctx.stroke();
      };
      ctx.strokeStyle = fg;
      ctx.lineWidth = 1.25;
      corner(10, 10, 1, 1);
      corner(w - 10, 10, -1, 1);
      corner(10, h - 10, 1, -1);
      corner(w - 10, h - 10, -1, -1);

      for (const e of v.edges) {
        const na = v.nodes[e.a]!;
        const nb = v.nodes[e.b]!;
        const x1 = mapX(na.x);
        const y1 = mapY(na.y);
        const x2 = mapX(nb.x);
        const y2 = mapY(nb.y);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        if (e.partitioned) {
          ctx.setLineDash([4, 5]);
          ctx.strokeStyle = warn;
          ctx.globalAlpha = 0.7;
          ctx.lineWidth = 1.25;
        } else {
          ctx.setLineDash([]);
          ctx.strokeStyle = signal;
          ctx.globalAlpha = 0.28 + Math.min(0.35, 180 / e.delay);
          ctx.lineWidth = e.delay > 800 ? 1 : 1.5;
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        ctx.font = "500 9px 'IBM Plex Mono', monospace";
        ctx.fillStyle = e.partitioned ? warn : muted;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(`${Math.round(e.delay)}ms`, mx, my - 4);
      }

      for (const p of v.packets) {
        const na = v.nodes[p.from]!;
        const nb = v.nodes[p.to]!;
        const x = mapX(na.x + (nb.x - na.x) * p.progress);
        const y = mapY(na.y + (nb.y - na.y) * p.progress);
        const ang = Math.atan2(nb.y - na.y, nb.x - na.x);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(ang);
        ctx.fillStyle = p.isBeacon ? muted : fg;
        ctx.globalAlpha = 0.9;
        ctx.fillRect(-5, -1.5, 10, 3);
        if (p.crystalCount > 0) {
          ctx.fillStyle = signal;
          ctx.beginPath();
          ctx.arc(6, 0, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      }

      for (const n of v.nodes) {
        const x = mapX(n.x);
        const y = mapY(n.y);
        const empty = n.values.every((val) => val < 0);
        const fill = replicaFill(n.fingerprint, empty);
        if (n.id === sel) {
          ctx.beginPath();
          ctx.arc(x, y, 18, 0, Math.PI * 2);
          ctx.strokeStyle = fg;
          ctx.globalAlpha = 0.85;
          ctx.lineWidth = 1.25;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        if (n.frozen > 0) {
          ctx.beginPath();
          ctx.arc(x, y, 15, 0, Math.PI * 2);
          ctx.strokeStyle = warn;
          ctx.globalAlpha = 0.55;
          ctx.setLineDash([2, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = "rgba(9,10,12,0.55)";
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.font = "500 10px 'IBM Plex Mono', monospace";
        ctx.fillStyle = fg;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(n.label, x, y + 14);
      }

      ctx.font = "400 10px 'IBM Plex Mono', monospace";
      ctx.fillStyle = subtle;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(
        `${v.protocol.toUpperCase()}  ·  T+${(v.now / 1000).toFixed(1)}s  ·  ${v.inflight} WAKES`,
        24,
        22,
      );
      ctx.textAlign = "right";
      ctx.fillText(
        v.consistent ? "UNISON" : `DIV ${v.divergence}`,
        w - 24,
        22,
      );

      raf = requestAnimationFrame(paint);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    raf = requestAnimationFrame(paint);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const pick = (clientX: number, clientY: number): Hit | null => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return null;
    const rect = wrap.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const padX = 36;
    const padY = 32;
    const mapX = (nx: number) => padX + nx * (rect.width - padX * 2);
    const mapY = (ny: number) => padY + ny * (rect.height - padY * 2);
    const v = getViewRef.current();
    let best: Hit | null = null;
    let bestD = 22;
    for (const n of v.nodes) {
      const dx = x - mapX(n.x);
      const dy = y - mapY(n.y);
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        best = { kind: "node", id: n.id };
      }
    }
    if (best) return best;
    let edgeBest = 10;
    for (const e of v.edges) {
      const na = v.nodes[e.a]!;
      const nb = v.nodes[e.b]!;
      const x1 = mapX(na.x);
      const y1 = mapY(na.y);
      const x2 = mapX(nb.x);
      const y2 = mapY(nb.y);
      const d = distToSeg(x, y, x1, y1, x2, y2);
      if (d < edgeBest) {
        edgeBest = d;
        best = { kind: "edge", a: e.a, b: e.b };
      }
    }
    return best;
  };

  return (
    <div
      ref={wrapRef}
      className="relative h-[min(58vh,560px)] min-h-[280px] w-full overflow-hidden rounded-lg bg-bg md:h-full md:min-h-[420px]"
    >
      <canvas
        ref={canvasRef}
        className="block size-full touch-none"
        onPointerUp={(ev) => {
          const hit = pick(ev.clientX, ev.clientY);
          if (!hit) return;
          if (hit.kind === "node") onSelect(hit.id);
          else onPartition(hit.a, hit.b);
        }}
        onDoubleClick={(ev) => {
          const hit = pick(ev.clientX, ev.clientY);
          if (hit?.kind === "node") onInject(hit.id);
        }}
      />
    </div>
  );
}

function distToSeg(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  if (len === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
