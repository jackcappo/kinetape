import { useApp } from '../state/AppContext';
import { bluetoothSupport } from '../device/WebBluetoothTransport';
import { IconBluetooth, IconPlay } from '../ui/icons';

export function ConnectButtons({ size = '' }: { size?: '' | 'lg' }) {
  const { connectBle, startDemo, phase } = useApp();
  const sup = bluetoothSupport();
  const busy = phase === 'connecting' || phase === 'session';
  return (
    <div className="row">
      <button className={`btn primary ${size}`} onClick={() => void connectBle()} disabled={!sup.ok || busy} title={sup.reason}>
        <IconBluetooth size={18} /> Connect KineTape
      </button>
      <button className={`btn ${size}`} onClick={() => void startDemo()} disabled={busy}>
        <IconPlay size={16} /> Demo mode
      </button>
    </div>
  );
}

export function ConnectPrompt({ what }: { what: string }) {
  const sup = bluetoothSupport();
  return (
    <div className="card empty">
      <h2>Connect your tape to {what}</h2>
      <p className="text-2">Pair a KineTape over Bluetooth, or explore with the simulated demo device.</p>
      <ConnectButtons />
      {!sup.ok && <p className="small muted" style={{ marginTop: 12 }}>{sup.reason}</p>}
    </div>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {children && <div className="row no-print">{children}</div>}
    </div>
  );
}
