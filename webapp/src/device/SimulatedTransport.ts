import { Emitter } from '../lib/emitter';
import { SimDevice, type SimOptions } from './SimDevice';
import type { DeviceTransport, NotifyChannel, TransportState } from './types';

export interface SimulatedTransportOptions extends SimOptions {
  deviceId?: string;
  name?: string;
  connectDelayMs?: number;
  /** Delay before auto-reconnect after a simulated link drop; < 0 disables auto-reconnect. */
  reconnectDelayMs?: number;
  /** Latency of a write-with-response. */
  writeLatencyMs?: number;
}

type Events = { status: DataView; history: DataView; live: DataView; state: TransportState; identify: void };

/**
 * DeviceTransport backed by an in-browser SimDevice. Bytes produced by the simulator are
 * delivered as DataViews exactly like Web Bluetooth notifications.
 */
export class SimulatedTransport implements DeviceTransport {
  readonly kind = 'sim' as const;
  readonly deviceId: string;
  readonly name: string;
  readonly sim: SimDevice;
  private emitter = new Emitter<Events>();
  private _state: TransportState = 'disconnected';
  private userDisconnect = false;
  private connectDelayMs: number;
  private reconnectDelayMs: number;
  private writeLatencyMs: number;

  constructor(opts: SimulatedTransportOptions = {}) {
    this.deviceId = opts.deviceId ?? 'sim-kinetape-demo';
    this.name = opts.name ?? 'KineTape-D3M0';
    this.connectDelayMs = opts.connectDelayMs ?? 350;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 1500;
    this.writeLatencyMs = opts.writeLatencyMs ?? 8;
    this.sim = new SimDevice(opts);
    this.sim.hooks = {
      notify: (channel: NotifyChannel, bytes: Uint8Array) => {
        // copy to a standalone buffer, like a BLE stack would
        const buf = new Uint8Array(bytes.byteLength);
        buf.set(bytes);
        this.emitter.emit(channel, new DataView(buf.buffer));
      },
      identify: () => this.emitter.emit('identify', undefined),
      dropLink: () => this.simulateLinkDrop(),
    };
    this.sim.start();
  }

  get state() {
    return this._state;
  }

  private setState(s: TransportState) {
    if (this._state === s) return;
    this._state = s;
    this.emitter.emit('state', s);
  }

  async connect() {
    this.userDisconnect = false;
    this.setState('connecting');
    await new Promise((r) => setTimeout(r, this.connectDelayMs));
    this.sim.connected = true;
    this.sim.historySubscribed = true;
    this.setState('connected');
  }

  async disconnect() {
    this.userDisconnect = true;
    this.sim.connected = false;
    this.sim.historySubscribed = false;
    this.setState('disconnected');
  }

  /** Fault injection: drop the link; auto-reconnects after reconnectDelayMs (if ≥ 0). */
  simulateLinkDrop() {
    if (this._state !== 'connected') return;
    this.sim.connected = false;
    this.sim.historySubscribed = false;
    if (this.reconnectDelayMs < 0) {
      this.setState('disconnected');
      return;
    }
    this.setState('reconnecting');
    setTimeout(() => {
      if (this.userDisconnect) return;
      this.sim.connected = true;
      this.sim.historySubscribed = true;
      this.setState('connected');
    }, this.reconnectDelayMs);
  }

  private assertConnected() {
    if (this._state !== 'connected') throw new Error('Not connected');
  }

  async readStatus(): Promise<DataView> {
    this.assertConnected();
    const b = this.sim.statusBytes();
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
  }

  async writeControl(bytes: Uint8Array): Promise<void> {
    this.assertConnected();
    const copy = bytes.slice();
    await new Promise((r) => setTimeout(r, this.writeLatencyMs));
    this.assertConnected();
    this.sim.handleControl(copy);
  }

  onNotify(channel: NotifyChannel, cb: (value: DataView) => void) {
    return this.emitter.on(channel, cb);
  }

  onStateChange(cb: (state: TransportState) => void) {
    return this.emitter.on('state', cb);
  }

  onIdentify(cb: () => void) {
    return this.emitter.on('identify', cb);
  }

  /** Stop timers (when the demo device is discarded). */
  dispose() {
    this.sim.stop();
    this.sim.connected = false;
    this.sim.historySubscribed = false;
    this.emitter.clear();
  }
}
