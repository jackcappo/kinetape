import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DeviceClient, type ClientPhase, type LogEntry, type SyncProgress, type SyncResult } from '../device/DeviceClient';
import { SimulatedTransport } from '../device/SimulatedTransport';
import { WebBluetoothTransport, bluetoothSupport } from '../device/WebBluetoothTransport';
import type { DeviceStatus, LivePacket } from '../protocol/codec';
import { DexieSyncStore, loadSettings, saveSettings } from '../db/db';
import { createDemoTransport, ensureDemoSeeded } from '../demo/seed';
import type { Settings } from '../types';
import { defaultSettings } from '../db/defaults';

export interface AppState {
  ready: boolean;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  client: DeviceClient | null;
  sim: SimulatedTransport | null;
  phase: ClientPhase;
  status: DeviceStatus | null;
  lastSync: SyncResult | null;
  syncProgress: SyncProgress | null;
  log: LogEntry[];
  error: string | null;
  identifyAt: number;
  connectBle: () => Promise<void>;
  startDemo: () => Promise<void>;
  disconnect: () => Promise<void>;
  syncNow: () => Promise<void>;
  clearError: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}

/** Subscribe to LIVE packets of the current device. */
export function useLiveStream(cb: (p: LivePacket) => void) {
  const { client } = useApp();
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    if (!client) return;
    return client.events.on('live', (p) => ref.current(p));
  }, [client]);
}

export const isConnectedPhase = (p: ClientPhase) => p === 'ready' || p === 'syncing' || p === 'session';

const store = new DexieSyncStore();

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<Settings>(defaultSettings());
  const [client, setClient] = useState<DeviceClient | null>(null);
  const [sim, setSim] = useState<SimulatedTransport | null>(null);
  const [phase, setPhase] = useState<ClientPhase>('disconnected');
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [identifyAt, setIdentifyAt] = useState(0);
  const clientRef = useRef<DeviceClient | null>(null);

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setReady(true);
    });
  }, []);

  // theme
  useEffect(() => {
    const el = document.documentElement;
    if (settings.theme === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void saveSettings(next);
      return next;
    });
  }, []);

  const attach = useCallback(
    async (c: DeviceClient) => {
      // tear down previous
      const prev = clientRef.current;
      if (prev && prev !== c) {
        void prev.disconnect().catch(() => undefined);
        prev.dispose();
        if (prev.transport instanceof SimulatedTransport) prev.transport.dispose();
      }
      clientRef.current = c;
      setClient(c);
      setLog([]);
      c.events.on('phase', setPhase);
      c.events.on('status', setStatus);
      c.events.on('sync', setLastSync);
      c.events.on('syncProgress', setSyncProgress);
      c.events.on('log', () => setLog([...c.logEntries]));
      setError(null);
      try {
        await c.connect();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [],
  );

  const connectBle = useCallback(async () => {
    const sup = bluetoothSupport();
    if (!sup.ok) {
      setError(sup.reason ?? 'Web Bluetooth unavailable');
      return;
    }
    let t: WebBluetoothTransport;
    try {
      t = await WebBluetoothTransport.request();
    } catch (e) {
      const msg = (e as Error).message;
      if (!/cancel/i.test(msg)) setError(msg);
      return;
    }
    setSim(null);
    updateSettings({ lastDevice: { kind: 'ble', id: t.deviceId, name: t.name } });
    await attach(new DeviceClient(t, store));
  }, [attach, updateSettings]);

  const startDemo = useCallback(async () => {
    const anchor = await ensureDemoSeeded();
    const s = await loadSettings(); // seeding may have updated the plan
    setSettings({ ...s, lastDevice: { kind: 'sim', id: 'sim-kinetape-demo', name: 'KineTape-D3M0' } });
    await saveSettings({ ...s, lastDevice: { kind: 'sim', id: 'sim-kinetape-demo', name: 'KineTape-D3M0' } });
    const t = createDemoTransport(anchor);
    t.onIdentify(() => setIdentifyAt(Date.now()));
    setSim(t);
    await attach(new DeviceClient(t, store));
  }, [attach]);

  const disconnect = useCallback(async () => {
    if (!client) return;
    await client.disconnect();
    if (client.transport instanceof SimulatedTransport) client.transport.dispose();
    client.dispose();
    clientRef.current = null;
    setClient(null);
    setSim(null);
    setStatus(null);
    setPhase('disconnected');
    updateSettings({ lastDevice: undefined });
  }, [client, updateSettings]);

  const syncNow = useCallback(async () => {
    if (!client) return;
    try {
      await client.readStatus();
      await client.sync();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [client]);

  // resume demo automatically after reload
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!ready || autoStarted.current) return;
    autoStarted.current = true;
    if (settings.lastDevice?.kind === 'sim') void startDemo();
  }, [ready, settings.lastDevice, startDemo]);

  const value = useMemo<AppState>(
    () => ({
      ready,
      settings,
      updateSettings,
      client,
      sim,
      phase,
      status,
      lastSync,
      syncProgress,
      log,
      error,
      identifyAt,
      connectBle,
      startDemo,
      disconnect,
      syncNow,
      clearError: () => setError(null),
    }),
    [ready, settings, updateSettings, client, sim, phase, status, lastSync, syncProgress, log, error, identifyAt, connectBle, startDemo, disconnect, syncNow],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
