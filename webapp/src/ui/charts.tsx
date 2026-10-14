import { useEffect, useState } from 'react';

/** Read chart colours from CSS custom properties (SVG attributes can't rely on var()). Updates on theme change. */
export function useChartColors() {
  const read = () => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string) => cs.getPropertyValue(n).trim();
    return {
      s1: v('--series-1'),
      s2: v('--series-2'),
      s3: v('--series-3'),
      s4: v('--series-4'),
      accent: v('--accent'),
      grid: v('--grid'),
      axis: v('--axis'),
      muted: v('--muted'),
      text2: v('--text-2'),
      surface: v('--surface'),
      good: v('--good'),
      seqLight: v('--seq-light'),
    };
  };
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const update = () => setColors(read());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', update);
    return () => {
      mo.disconnect();
      mq.removeEventListener('change', update);
    };
  }, []);
  return colors;
}

export type ChartColors = ReturnType<typeof useChartColors>;

export const axisProps = (c: ChartColors) => ({
  stroke: c.axis,
  tick: { fill: c.muted, fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: c.axis },
});

interface TipRow {
  name?: string | number;
  value?: number | string | (number | string)[];
  color?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}

/** Shared tooltip body. */
export function ChartTip({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter,
}: {
  active?: boolean;
  payload?: TipRow[];
  label?: string | number;
  labelFormatter?: (l: string | number, p?: Record<string, unknown>) => string;
  valueFormatter?: (v: number, key: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <div className="t">{labelFormatter && label !== undefined ? labelFormatter(label, payload[0]?.payload) : label}</div>
      {payload.map((p, i) => (
        <div className="r" key={i}>
          <span className="sw" style={{ background: p.color }} />
          <span>{p.name}:</span>
          <b>{valueFormatter && typeof p.value === 'number' ? valueFormatter(p.value, String(p.dataKey)) : String(p.value)}</b>
        </div>
      ))}
    </div>
  );
}
