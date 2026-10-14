import { useEffect, useState, type ReactNode } from 'react';
import type { Insight } from '../insights';
import { IconAlert, IconInfo, IconStar } from './icons';

export function Card({ title, hint, action, children, className = '' }: { title?: ReactNode; hint?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {hint && <div className="hint">{hint}</div>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, unit, foot }: { label: string; value: ReactNode; unit?: string; foot?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {foot && <div className="foot">{foot}</div>}
    </div>
  );
}

export function GoalRing({ value, goal, label, unit, color = 'var(--accent)', size = 112 }: { value: number; goal: number; label: string; unit?: string; color?: string; size?: number }) {
  const r = size / 2 - 9;
  const c = 2 * Math.PI * r;
  const frac = goal > 0 ? Math.min(1, value / goal) : 0;
  const met = goal > 0 && value >= goal;
  return (
    <div className="ring">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}: ${value} of ${goal}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={10} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          opacity={frac > 0 ? 1 : 0}
          stroke={color}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dasharray .4s' }}
        />
        <text x="50%" y="47%" textAnchor="middle" fontSize={size * 0.21} fontWeight={700} fill="var(--text)">
          {Math.round(value)}
        </text>
        <text x="50%" y="64%" textAnchor="middle" fontSize={size * 0.1} fill="var(--muted)">
          of {goal}
          {unit ? ` ${unit}` : ''}
        </text>
      </svg>
      <div className="ring-label">
        {label} {met && <span style={{ color: 'var(--good-text)' }}>✓</span>}
      </div>
    </div>
  );
}

/** Semi-circular activation gauge (0–100 %), with a threshold tick. */
export function Gauge({ pct, threshold, active }: { pct: number; threshold: number; active: boolean }) {
  const w = 260;
  const h = 150;
  const cx = w / 2;
  const cy = 136;
  const r = 110;
  const p = Math.max(0, Math.min(100, pct)) / 100;
  const pt = (f: number, rr = r) => {
    const a = Math.PI * (1 - f);
    return [cx + rr * Math.cos(a), cy - rr * Math.sin(a)];
  };
  const [x1, y1] = pt(0);
  const [x2, y2] = pt(p);
  const [tx1, ty1] = pt(threshold / 100, r - 18);
  const [tx2, ty2] = pt(threshold / 100, r + 14);
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ maxWidth: 300 }} role="img" aria-label={`Activation ${Math.round(pct)} percent`}>
      <path d={`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke="var(--surface-2)" strokeWidth={18} strokeLinecap="round" />
      {p > 0.005 && (
        <path
          d={`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`}
          fill="none"
          stroke={active ? 'var(--accent)' : 'var(--series-1)'}
          strokeWidth={18}
          strokeLinecap="round"
        />
      )}
      <line x1={tx1} y1={ty1} x2={tx2} y2={ty2} stroke="var(--text-2)" strokeWidth={2} strokeDasharray="3 2" />
      <text x={cx} y={cy - 26} textAnchor="middle" fontSize={44} fontWeight={750} fill="var(--text)" className="tabular">
        {Math.round(pct)}
        <tspan fontSize={20} fill="var(--muted)">
          %
        </tspan>
      </text>
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize={12} fill="var(--muted)">
        of calibrated max
      </text>
    </svg>
  );
}

export function InsightCard({ insight }: { insight: Insight }) {
  const Icon = insight.tone === 'caution' ? IconAlert : insight.tone === 'positive' ? IconStar : IconInfo;
  const color = insight.tone === 'caution' ? '#b26a00' : insight.tone === 'positive' ? 'var(--good-text)' : 'var(--series-1)';
  const label = insight.tone === 'caution' ? 'Heads-up' : insight.tone === 'positive' ? 'Progress' : 'Note';
  return (
    <div className={`insight ${insight.tone}`}>
      <Icon className="ico" style={{ color }} aria-label={label} />
      <div>
        <h3>{insight.title}</h3>
        <p>{insight.body}</p>
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Pill({ tone, children }: { tone?: 'ok' | 'warn' | 'bad' | 'busy'; children: ReactNode }) {
  return (
    <span className={`pill ${tone ?? ''}`}>
      <span className="dot" />
      {children}
    </span>
  );
}

/** Re-render periodically (for countdowns / "x min ago"). */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function Disclaimer({ compact = false }: { compact?: boolean }) {
  return compact ? (
    <span>
      <strong>Not a medical device.</strong> KineTape provides general wellness information and does not diagnose or treat any condition. Always follow the advice of your surgeon and physical therapist.
    </span>
  ) : (
    <div className="notice">
      <IconInfo />
      <span>
        <strong>General guidance only — not medical advice.</strong> KineTape is a research/wellness prototype, not a medical device. Activation readings are relative to your own calibration and are not a clinical strength measurement. Your surgeon’s and physical therapist’s protocol always takes precedence. Seek care promptly for severe pain, sudden swelling, calf pain, fever, or wound concerns.
      </span>
    </div>
  );
}
