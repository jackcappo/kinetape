import { useEffect, useState, type ComponentType } from 'react';
import { useApp, isConnectedPhase } from './state/AppContext';
import { Disclaimer, Pill } from './ui/components';
import {
  IconBluetooth,
  IconBook,
  IconDumbbell,
  IconMenu,
  IconPulse,
  IconSettings,
  IconShare,
  IconSun,
  IconTrend,
} from './ui/icons';
import { TodayPage } from './pages/TodayPage';
import { LivePage } from './pages/LivePage';
import { DevicePage } from './pages/DevicePage';
import { ExercisePage } from './pages/ExercisePage';
import { ProgressPage } from './pages/ProgressPage';
import { PlanPage } from './pages/PlanPage';
import { ReportPage } from './pages/ReportPage';
import { SettingsPage } from './pages/SettingsPage';

interface Route {
  path: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
  page: ComponentType;
}

const ROUTES: Route[] = [
  { path: 'today', label: 'Today', icon: IconSun, page: TodayPage },
  { path: 'live', label: 'Live', icon: IconPulse, page: LivePage },
  { path: 'exercise', label: 'Exercises', icon: IconDumbbell, page: ExercisePage },
  { path: 'progress', label: 'Progress', icon: IconTrend, page: ProgressPage },
  { path: 'plan', label: 'Plan & journal', icon: IconBook, page: PlanPage },
  { path: 'report', label: 'Share / report', icon: IconShare, page: ReportPage },
  { path: 'device', label: 'Device', icon: IconBluetooth, page: DevicePage },
  { path: 'settings', label: 'Settings', icon: IconSettings, page: SettingsPage },
];

function useHashRoute(): string {
  const get = () => window.location.hash.replace(/^#\/?/, '').split('?')[0] || 'today';
  const [r, setR] = useState(get);
  useEffect(() => {
    const on = () => {
      setR(get());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

function ConnectionPill() {
  const { phase, client, syncProgress } = useApp();
  if (!client || phase === 'disconnected') return <Pill>Not connected</Pill>;
  if (phase === 'reconnecting') return <Pill tone="warn">Reconnecting…</Pill>;
  if (phase === 'connecting' || phase === 'session') return <Pill tone="busy">Connecting…</Pill>;
  if (phase === 'syncing' || syncProgress) return <Pill tone="busy">Syncing…</Pill>;
  if (phase === 'error') return <Pill tone="bad">Error</Pill>;
  return <Pill tone="ok">{client.transport.kind === 'sim' ? 'Demo device' : client.transport.name}</Pill>;
}

export function App() {
  const route = useHashRoute();
  const { ready, phase, client } = useApp();
  const [menu, setMenu] = useState(false);
  const current = ROUTES.find((r) => r.path === route) ?? ROUTES[0];
  const Page = current.page;
  useEffect(() => setMenu(false), [route]);
  useEffect(() => {
    document.title = `${current.label} · KineTape`;
  }, [current.label]);

  return (
    <div className="app">
      <aside className={`sidebar ${menu ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-mark">
            <IconPulse size={18} />
          </span>
          KineTape
        </div>
        <nav className="nav" aria-label="Main">
          {ROUTES.map((r) => (
            <a key={r.path} href={`#/${r.path}`} className={r.path === current.path ? 'active' : ''} aria-current={r.path === current.path ? 'page' : undefined}>
              <r.icon size={19} />
              {r.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot stack">
          <ConnectionPill />
          <span>
            {client && isConnectedPhase(phase) ? 'Tape connected' : 'Data is stored only in this browser.'}
          </span>
        </div>
      </aside>
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      <div className="main">
        <header className="topbar">
          <button className="btn icon ghost" aria-label="Open menu" onClick={() => setMenu(true)}>
            <IconMenu />
          </button>
          <strong>{current.label}</strong>
          <a href="#/device" style={{ textDecoration: 'none' }}>
            <ConnectionPill />
          </a>
        </header>
        <main className="content">{ready ? <Page /> : <div className="empty">Loading…</div>}</main>
        <footer className="footer">
          <Disclaimer compact />
        </footer>
      </div>
    </div>
  );
}
