import { useApp } from '../state/AppContext';
import { clearAllData } from '../db/db';
import { EXERCISES } from '../exercises/presets';
import { ensureDemoSeeded } from '../demo/seed';
import { Card, Disclaimer, Segmented } from '../ui/components';
import { PageHead } from './common';
import type { ThemePref } from '../types';

const toTime = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const fromTime = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + (m || 0);
};

export function SettingsPage() {
  const { settings, updateSettings, disconnect, client } = useApp();
  const g = settings.goals;
  const setGoal = (k: keyof typeof g, v: number) => updateSettings({ goals: { ...g, [k]: Math.max(0, Math.round(v)) } });
  const toggleEx = (id: string) =>
    updateSettings({ program: settings.program.includes(id) ? settings.program.filter((x) => x !== id) : [...settings.program, id] });

  return (
    <>
      <PageHead title="Settings" />
      <div className="grid grid-2">
        <Card title="Daily goals" hint="Agree targets with your physical therapist">
          <div className="grid grid-3">
            <label className="field">
              Active minutes
              <input type="number" min={0} value={g.activeMinutes} onChange={(e) => setGoal('activeMinutes', Number(e.target.value))} />
            </label>
            <label className="field">
              Reps
              <input type="number" min={0} value={g.reps} onChange={(e) => setGoal('reps', Number(e.target.value))} />
            </label>
            <label className="field">
              Exercise sessions
              <input type="number" min={0} max={10} value={g.sessions} onChange={(e) => setGoal('sessions', Number(e.target.value))} />
            </label>
          </div>
        </Card>
        <Card title="Waking hours" hint="Used for “longest still stretch”">
          <div className="grid grid-2">
            <label className="field">
              From
              <input type="time" value={toTime(settings.wakeStartMin)} onChange={(e) => e.target.value && updateSettings({ wakeStartMin: fromTime(e.target.value) })} />
            </label>
            <label className="field">
              To
              <input type="time" value={toTime(settings.wakeEndMin)} onChange={(e) => e.target.value && updateSettings({ wakeEndMin: fromTime(e.target.value) })} />
            </label>
          </div>
        </Card>
        <Card title="Display">
          <div className="stack" style={{ gap: 14 }}>
            <div className="field">
              Theme
              <Segmented<ThemePref>
                value={settings.theme}
                onChange={(theme) => updateSettings({ theme })}
                options={[
                  { value: 'system', label: 'System' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
              />
            </div>
            <div className="field">
              Time format
              <Segmented
                value={settings.timeFormat}
                onChange={(timeFormat) => updateSettings({ timeFormat })}
                options={[
                  { value: '12h', label: '12-hour' },
                  { value: '24h', label: '24-hour' },
                ]}
              />
            </div>
            <div className="field">
              Activation units
              <Segmented
                value={settings.activationUnit}
                onChange={(activationUnit) => updateSettings({ activationUnit })}
                options={[
                  { value: 'percent', label: '% of max' },
                  { value: 'permille', label: '‰ (device units)' },
                ]}
              />
            </div>
            <p className="small muted">Range of motion is always recorded in degrees.</p>
          </div>
        </Card>
        <Card title="Exercise program" hint="Which exercises appear on the Exercises page">
          <div className="stack">
            {EXERCISES.map((e) => (
              <label key={e.id} className="row small">
                <input type="checkbox" checked={settings.program.includes(e.id)} onChange={() => toggleEx(e.id)} />
                <b>{e.name}</b>
                <span className="muted">
                  {e.sets}×{e.reps}, hold {e.holdS}s
                </span>
              </label>
            ))}
          </div>
        </Card>
        <Card title="Data">
          <div className="stack">
            <p className="text-2 small">
              All data stays in this browser (IndexedDB). Use <a href="#/report">Share / report</a> for CSV exports and a full JSON backup you can import on another
              device.
            </p>
            <div className="row">
              <button
                className="btn"
                onClick={async () => {
                  if (!confirm('Re-generate the demo dataset? Demo minute records and demo sessions are replaced; your own journal entries are kept.')) return;
                  await ensureDemoSeeded(true);
                  location.reload();
                }}
              >
                Reset demo data
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  if (!confirm('Delete ALL KineTape data in this browser (minute records, sessions, journal, settings)? This cannot be undone.')) return;
                  if (!confirm('Are you sure? Consider downloading a backup first.')) return;
                  if (client) await disconnect();
                  await clearAllData();
                  location.hash = '#/today';
                  location.reload();
                }}
              >
                Clear all data
              </button>
            </div>
          </div>
        </Card>
        <Card title="About KineTape">
          <div className="stack">
            <p className="text-2 small">
              KineTape pairs kinesiology tape with a thin-film pressure sensor and an ESP32 to track muscle activity throughout the day during rehabilitation. This
              web app talks to the tape over Bluetooth Low Energy (protocol v1), stores everything locally, and helps you share progress with your physical
              therapist.
            </p>
            <Disclaimer />
          </div>
        </Card>
      </div>
    </>
  );
}
