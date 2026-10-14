import { useEffect, useRef, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { useApp, useLiveStream, isConnectedPhase } from '../state/AppContext';
import { RepTracker, type RepEvent } from '../exercises/repTracker';
import { Card, Gauge, Stat } from '../ui/components';
import { axisProps, useChartColors } from '../ui/charts';
import { ConnectPrompt, PageHead } from './common';
import { IconAlert } from '../ui/icons';
import type { LivePacket } from '../protocol/codec';

const WINDOW_MS = 10_000;

/** Shared live-signal state: ring buffer + rep tracker, re-rendering at ~12 fps. */
export function useLiveSignal() {
  const buf = useRef<{ t: number; v: number; c: boolean }[]>([]);
  const tracker = useRef(new RepTracker());
  const [latest, setLatest] = useState<LivePacket | null>(null);
  const [reps, setReps] = useState<RepEvent[]>([]);
  const [, setFrame] = useState(0);
  const dirty = useRef(false);

  useLiveStream((p) => {
    const arr = buf.current;
    if (arr.length && p.uptimeMs < arr[arr.length - 1].t) arr.length = 0; // reboot
    arr.push({ t: p.uptimeMs, v: p.activationPermille / 10, c: p.contracting });
    while (arr.length && arr[0].t < p.uptimeMs - WINDOW_MS) arr.shift();
    const ev = tracker.current.push(p);
    if (ev) setReps((r) => [...r, ev]);
    setLatest(p);
    dirty.current = true;
  });
  useEffect(() => {
    const id = setInterval(() => {
      if (dirty.current) {
        dirty.current = false;
        setFrame((f) => f + 1);
      }
    }, 80);
    return () => clearInterval(id);
  }, []);
  const reset = () => {
    setReps([]);
    tracker.current.reset();
  };
  return { buffer: buf.current, latest, reps, tracker: tracker.current, reset };
}

export function LiveChart({ buffer, threshold, height = 260 }: { buffer: { t: number; v: number }[]; threshold: number; height?: number }) {
  const c = useChartColors();
  const end = buffer.length ? buffer[buffer.length - 1].t : 0;
  const data = buffer.map((b) => ({ x: (b.t - end) / 1000, v: b.v }));
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id="liveFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={c.s1} stopOpacity={0.35} />
              <stop offset="100%" stopColor={c.s1} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="x" type="number" domain={[-10, 0]} ticks={[-10, -8, -6, -4, -2, 0]} tickFormatter={(v) => `${v}s`} {...axisProps(c)} />
          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} {...axisProps(c)} />
          <ReferenceLine y={threshold} stroke={c.muted} strokeDasharray="4 3" label={{ value: `threshold ${threshold}%`, position: 'insideTopLeft', fill: c.muted, fontSize: 11 }} />
          <Area type="monotone" dataKey="v" stroke={c.s1} strokeWidth={2} fill="url(#liveFill)" isAnimationActive={false} dot={false} name="Activation" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function LivePage() {
  const { client, phase, status, settings } = useApp();
  const { buffer, latest, reps, tracker, reset } = useLiveSignal();
  if (!client || phase === 'disconnected') return (
    <>
      <PageHead title="Live" sub="Real-time muscle activation" />
      <ConnectPrompt what="see live activation" />
    </>
  );
  const threshold = status?.thresholdPct ?? 30;
  const pct = latest ? latest.activationPermille / 10 : 0;
  const cur = latest ? tracker.current(latest.uptimeMs) : null;
  const peakView = buffer.reduce((m, b) => Math.max(m, b.v), 0);
  const lastRep = reps[reps.length - 1];
  const fmt = (pm: number) => (settings.activationUnit === 'permille' ? `${Math.round(pm)}‰` : `${Math.round(pm / 10)}%`);
  return (
    <>
      <PageHead title="Live" sub="Real-time muscle activation from the LIVE stream (20 Hz)">
        <button className="btn" onClick={reset}>
          Reset rep counter
        </button>
      </PageHead>
      {latest && !latest.sensorOk && (
        <div className="notice warn">
          <IconAlert /> No contact — the sensor reads near zero. Re-apply the tape a little firmer over the muscle.
        </div>
      )}
      {latest && !latest.calibrated && (
        <div className="notice">
          Not calibrated yet — percentages use default values. <a href="#/device">Calibrate on the Device page</a> for meaningful numbers.
        </div>
      )}
      {!isConnectedPhase(phase) && <div className="notice">Connection: {phase}…</div>}
      <div className="live-hero">
        <Card>
          <div className="gauge-wrap">
            <Gauge pct={pct} threshold={threshold} active={!!latest?.contracting} />
            <span className={`contract-badge ${latest?.contracting ? 'on' : ''}`} aria-live="polite">
              {latest?.contracting ? 'Contracting' : 'Relaxed'}
            </span>
            <div className="small muted tabular">
              {cur ? `Holding ${(cur.holdMs / 1000).toFixed(1)} s` : lastRep ? `Last hold ${(lastRep.holdMs / 1000).toFixed(1)} s · peak ${fmt(lastRep.peakPermille)}` : 'Contract to start a rep'}
            </div>
          </div>
        </Card>
        <Card title="Last 10 seconds" hint="Dashed line: contraction threshold">
          <LiveChart buffer={buffer} threshold={threshold} />
        </Card>
      </div>
      <div className="grid grid-4">
        <Stat label="Reps (this view)" value={reps.length} foot="contractions ≥ 200 ms" />
        <Stat label="Reps today (device)" value={status?.repsToday ?? '—'} foot="since local midnight" />
        <Stat label="Peak (10 s window)" value={Math.round(peakView)} unit="%" />
        <Stat
          label="Signal"
          value={latest ? latest.raw : '—'}
          unit="raw"
          foot={client ? `${client.liveStats.received} packets · ${client.liveStats.lost} lost` : undefined}
        />
      </div>
    </>
  );
}
