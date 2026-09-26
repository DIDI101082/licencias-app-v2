import { usoDisco, type Disco } from "@/lib/monitoreo";

export default function BarraDisco({ d }: { d: Disco }) {
  const uso = usoDisco(d);
  const color = uso >= 90 ? "bg-red-500" : uso >= 75 ? "bg-amber-500" : "bg-brand-500";
  return (
    <div className="text-xs min-w-[140px]">
      <div className="flex justify-between text-ink/60">
        <span>{d.unidad}</span>
        <span>{d.libre_gb} GB libres de {d.total_gb}</span>
      </div>
      <div className="h-1.5 bg-line/[0.06] rounded-full mt-0.5 overflow-hidden" role="meter" aria-valuenow={uso} aria-valuemin={0} aria-valuemax={100} aria-label={`Disco ${d.unidad} ${uso}% usado`}>
        <div className={`h-full rounded-full ${color}`} style={{ width: `${uso}%` }} />
      </div>
    </div>
  );
}
