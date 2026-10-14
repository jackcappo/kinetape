# KineTape web app

Local-first web app for **KineTape**: kinesiology tape with a thin-film pressure sensor and an ESP32 that tracks muscle activity all day during physical-therapy recovery (ACL reconstruction and similar long rehabs). It talks to the tape over **Web Bluetooth** using the protocol in [`../PROTOCOL.md`](../PROTOCOL.md). It also has a **Demo mode**: a simulated tape that speaks the same protocol bytes.

> Not a medical device. The app gives general wellness information only. The disclaimer appears in the footer of every page, on the Plan page and in reports.

## Run

```bash
cd webapp
npm install
npm run dev          # http://localhost:5173 (Web Bluetooth works on localhost)
npm test             # vitest run: protocol vectors, DeviceClient sync, analytics, insights, exercises, demo
npm run build        # tsc (strict, no emit) + vite build -> dist/
npm run preview      # serve dist/
```

Web Bluetooth needs a **secure context**: `https://…` or `http://localhost`. To use a phone on your LAN, serve `dist/` over HTTPS (for example behind a tunnel). The build uses relative asset paths (`base: './'`), so `dist/` can go on any static host.

### Browser support

| Browser | Real tape (BLE) | Demo mode |
|---|---|---|
| Chrome / Edge (desktop: Windows, macOS, Linux, ChromeOS) | ✅ | ✅ |
| Chrome on Android | ✅ | ✅ |
| Safari (macOS / iOS), Firefox | ❌ no Web Bluetooth. The app explains why and points to Chrome/Edge (on iOS, the Bluefy browser) | ✅ |

## Screens

- **Device**: connect a real tape or start Demo mode. The status card shows contact/sensor, calibration, clock, stored minutes, cursor, battery ("unknown") and the last command result. Also on this page:
  - a calibration wizard (relax → `CALIBRATE_REST`, then max → `CALIBRATE_MAX`) that shows `calib_state` and the result codes
  - a threshold slider (`SET_THRESHOLD`), Identify, and Sync now
  - a session log
  - demo fault injection: flex button, loose tape, failing max calibration, link drop, power cycle, `CLEAR_HISTORY`
- **Live**: activation gauge, scrolling 10 s chart with the threshold line, contraction indicator, hold timer, rep counter, packet-loss counter.
- **Today**: goal rings (active minutes, reps, sessions); active minutes, reps, mean and peak activation; hourly chart; longest still stretch in waking hours; top insights. You can step to earlier days.
- **Exercises**: guided sessions for quad sets, straight-leg raises, short-arc quads, terminal knee extension and wall sits. Each has sets × reps and a hold target. The LIVE stream drives rep counting, hold time and quality (peak as % of calibrated max). There are rest timers, per-rep feedback, and results are saved. In demo mode the simulated tape can perform the reps.
- **Progress**: daily (30 d), weekly (12 wk) and monthly (6 mo) trends for active minutes, reps, peak activation and session adherence. Recalibrations are marked with lines on the peak chart. Also shows current and longest streak, days at goal, and all insights.
- **Plan & journal**: injury type (ACL reconstruction by default) and surgery or injury date, giving "week N post-op". Generic phase milestones, clearly labelled as general guidance. Daily log of pain 0–10, swelling, knee flexion and extension in degrees, and notes, with charts.
- **Share / report**: printable PT report with a date-range picker, key metrics, charts, observations, sessions, journal and an "about these numbers" section. Print CSS makes "Save as PDF" produce a clean page. Also CSV export (minute records, sessions, journal) and a full JSON backup with import (merge or replace).
- **Settings**: daily goals, waking hours, time format, activation units (% or ‰), theme (system/light/dark), exercise program, reset demo data, clear all data, about/disclaimer.

## Architecture

```
src/
  protocol/      Pure TS codec (DataView, little-endian). No DOM, no BLE.
    constants.ts   UUIDs, opcodes, result codes, flag bits
    codec.ts       decodeLive/decodeRecord/decodeHistoryPacket/decodeStatus,
                   encoders for every CONTROL opcode (+ LIVE/record/RECORDS/END/STATUS
                   encoders and decodeControl, used by the simulator)
    codec.test.ts  asserts every vector in ../protocol/test-vectors.json, byte-exact, both directions
  device/
    types.ts                 DeviceTransport interface (raw bytes only), SyncStore, StoredRecord, MemorySyncStore
    WebBluetoothTransport.ts navigator.bluetooth: filter by service UUID / namePrefix "KineTape",
                             subscribe STATUS/HISTORY/LIVE, write CONTROL with response, serialized GATT ops,
                             auto-reconnect with backoff after an unexpected disconnect
    SimDevice.ts             fake firmware: 100 Hz EMA, hysteresis reps, minute ring log, STATUS/LIVE,
                             async calibration, paced SYNC_HISTORY chunking (MTU-aware), firmware arg checks
    SimulatedTransport.ts    DeviceTransport adapter around SimDevice (latency, link-drop injection)
    DeviceClient.ts          session flow, command acks, sync/cursor/dedupe, time conversion, calibration
    DeviceClient.test.ts     sync flow against SimulatedTransport (resume, cleared device, ring loss, …)
  db/            Dexie (IndexedDB) schema, DexieSyncStore, backup/CSV
  analytics/     pure day/week/month summaries, streaks, local-time helpers (+ tests)
  insights/      pure insight rules + stats (+ tests)
  exercises/     presets, RepTracker (LIVE → reps), session state machine (+ tests)
  plan/          generic phase milestones per injury type
  demo/          deterministic 6-week recovery dataset + DB seeding + demo transport (+ tests)
  state/         React context (device/client lifecycle, settings) and live-query data hooks
  pages/, ui/    screens, components, chart helpers (Recharts)
```

### How BLE integrates

`DeviceTransport` only moves bytes. `connect()` subscribes to the three notify characteristics. `readStatus()` reads STATUS, `writeControl()` writes CONTROL with response, and `onNotify(channel)` delivers DataViews. **All decoding happens in `DeviceClient`.** The simulator encodes real protocol bytes and runs through the same decoders as the real device.

`DeviceClient.connect()` follows "Typical app session":

1. Connect and subscribe STATUS/HISTORY/LIVE, then read STATUS.
2. Send `SET_TIME(now, tz)`. The client arms a STATUS listener before writing and waits for the notification with `last_cmd == 0x01`. If none arrives it falls back to reading STATUS. It then reads a fresh STATUS snapshot.
3. Send `SYNC_HISTORY(cursor)` and collect RECORDS until END:
   - Records are converted to wall-clock time and upserted, deduplicated by `(deviceId, generation, index)`. A row is replaced only when the new time is better (device > converted > estimated > unknown).
   - The client then persists the cursor.
   - If `STATUS.next_index < cursor`, it starts a new local generation and resyncs from 0.
4. LIVE packets are emitted continuously to the Live view and guided exercises.

After an unexpected disconnect the transport reconnects, and the client re-runs steps 1–3 by itself.

Persistence goes through the `SyncStore` interface: Dexie in the app, an in-memory store in tests.

## Protocol notes (interpretations; PROTOCOL.md is unchanged)

1. **`tz_offset_min` sign.** The test vector uses `-240`, which is US Eastern daylight time. So the value is **minutes east of UTC**: `tz_offset_min = -Date.getTimezoneOffset()`. The app clamps it to ±840, because firmware rejects larger values as bad_args.
2. **Command acknowledgement.** "After every command … notifies STATUS". The client treats the first STATUS notification after the write with `last_cmd == opcode` as the ack and reads `last_result` from it. If no notification arrives within 4 s, it reads STATUS instead.
3. **Calibration result.** The client reads the outcome of `CALIBRATE_REST`/`MAX` from the *second* notification (`calib_state` back to 0, `last_cmd` = opcode, `last_result` 0 or 4).
   - A `last_result ≠ 0` before sampling starts (for example busy) is reported immediately.
   - An "idle + ok" STATUS seen before sampling is ignored, because it could be a stale periodic STATUS.
   - If no end notification arrives, the client polls STATUS.
4. **Unsynced-time conversion.**
   - The client uses `epoch = epoch_now − uptime_s + t` only when `boot_id == STATUS.boot_id` and `epoch_now != 0`. The STATUS used is the snapshot read right after SET_TIME. `epoch_now − uptime_s` is constant for a boot, so the snapshot's age doesn't matter.
   - Older unsynced boots are **estimated** ("app may estimate") from the nearest *later* record of the same boot with a known time, over contiguous indices: `anchor − Δindex × 60 s`. Accuracy is about one minute.
   - Anything else is stored with `timeSource = 'unknown'`. It is kept, but excluded from charts, and the count is shown on the Device page.
5. **Dedupe key and clears.** After `CLEAR_HISTORY`, indices restart at 0, so a plain `(deviceId, index)` key would collide with old data. The app adds a local **generation** counter, bumped when it sees `STATUS.next_index < cursor` or after it sends `CLEAR_HISTORY` itself. *Limitation:* if a device is cleared out of band and then records at least `cursor` new minutes before the next connection, the protocol has no way to detect the reset.
6. **Cursor.**
   - The cursor becomes `END.next_index` only when every index from the first one the device sent up to `next_index` was received.
   - If a packet is missing, the cursor stops at the contiguous end and the client re-requests, up to 2 times.
   - If the link drops mid-transfer, the records received so far are saved and the cursor is set to the contiguous end, so the next sync resumes from there.
   - `END.status ≠ 0` (for example when the MTU is too small for one record) leaves the cursor unchanged and shows an error.
   - If the first index is above the cursor (the ring buffer overwrote records), the shortfall is reported as `lostToRing`.
7. **Decoder strictness.** Packets that are too short or have the wrong type byte throw `ProtocolError`. Longer packets are accepted and the trailing bytes ignored, for forward compatibility. A RECORDS count of 0 is rejected.
8. **Reps in the app.** Guided sessions and the Live view count reps from the LIVE `contracting` bit, which carries the firmware's hysteresis. Contractions shorter than 200 ms are dropped, matching the firmware rule. Hold time is measured on `uptime_ms`. "Quality" is the peak `activation_permille` during the contraction.
9. **Sensor flag.** `sensor_ok = 0` usually means the ZD10-100 has no contact, not a hardware fault. The UI says *"No contact — re-apply tape firmer"*.
10. **Battery and LIVE seq.** `battery_pct = 255` is shown as "unknown". LIVE `seq` continues across connections, so loss is counted only between consecutive packets within a session.
11. **Device identity.** On real hardware, `deviceId` is the Web Bluetooth `device.id`, which is random per origin and stable while the site permission exists. If the permission is revoked, the tape looks like a new device and is fully resynced from index 0. The old rows stay under the old id.
12. **App-level definitions (not part of the protocol).**
    - **Active minute:** `active_seconds ≥ 10` or `reps ≥ 1`.
    - **Inactive minute:** `active_seconds < 2` and `reps == 0`. Missing minutes, when the tape is not worn, break an inactive stretch.
    - **Strength proxy:** daily peak activation. It is only comparable within one calibration, so recalibrations are recorded (both observed changes in `rest_raw`/`max_raw` and wizard results) and marked on charts.

## Demo mode

Starting Demo mode does two things:

- **Seeds IndexedDB** with about 6 weeks of a deterministic ACL-reconstruction recovery: minute records, guided sessions, journal entries and 3 calibrations.
- **Creates a simulated tape** whose ring log continues that dataset up to "now". The data is anchored, so reloading later reproduces the same indices.

The database is seeded only up to the start of the previous boot. The first connect then pulls the last ~1–2 days through the real protocol. That transfer includes unsynced current-boot records (converted) and an earlier boot's pre-SET_TIME records (estimated). After that the simulator runs a realistic 100 Hz signal model in real time and appends real minute records.

## Notes for the firmware team

- The app filters on `services: [8f1e0000-…]` **or** `namePrefix: "KineTape"`. Please put the service UUID in the advertisement or scan response so the chooser shows the device.
- Before any CONTROL write, the app subscribes in this order: STATUS → HISTORY → LIVE. It always uses **write with response**.
- The app relies on a STATUS **notification** after every command, and on the second notification when calibration finishes. Without them it falls back to polling, which works but is slower.
- RECORDS packets: n from 1 to 10, indices consecutive within a packet, and packets sent in increasing index order. The app tolerates gaps and re-requests, but each gap costs a round trip.
- END: `next_index` should be the index after the last record *sent* in this transfer. The app uses it directly as the new cursor.
- SET_TIME is sent on every connect, including reconnects. Re-setting the time while it is already valid should be harmless (no new boot, no log changes).
- A LIVE `uptime_ms` that jumps backwards is treated as a reboot by the rep tracker.
