# KineTape BLE Protocol v1 (integration contract)

This file is the **single source of truth** shared by `firmware/` (ESP32) and `webapp/`.
Neither side may change it unilaterally. Byte-exact examples live in
`protocol/test-vectors.json` — both implementations must agree with them.

All multi-byte integers are **little-endian**, structs are **packed** (no padding).
`u8/u16/u32` unsigned, `i16` signed.

## Hardware assumptions (MVP)

- ESP32 DevKit (esp32dev), Arduino framework.
- Sensor: ZD10-100 thin-film resistive pressure sensor, wired as a voltage divider:
  `3V3 — sensor — GPIO34 (ADC1_CH6) — 10kΩ — GND`. More pressure ⇒ higher ADC reading.
- Onboard LED on GPIO2 (status / identify).
- Sampling: 100 Hz ADC (12-bit, 0–4095), EMA-filtered.

## Signal processing (firmware)

- `filtered = EMA(raw, alpha=0.2)`
- `activation_permille = clamp((filtered - rest_raw) / (max_raw - rest_raw), 0, 1) * 1000`
  - Uncalibrated defaults: `rest_raw` = mean of first 2 s after boot, `max_raw` = 4095.
- **Contraction / rep detection** (hysteresis): contraction starts when activation ≥ `threshold_pct*10`,
  ends when activation < `threshold_pct*10*0.6`. A rep is counted on end if it lasted ≥ 200 ms.
  Default `threshold_pct` = 30.
- **Minute summaries**: every wall-clock minute (or every 60 s of uptime if time is not set) the
  device appends one 16-byte record to a persistent ring log (LittleFS), ≥ 7 days capacity.
- `sensor_ok` = false if raw stays ≤ 5 or ≥ 4090 for > 2 s (open/short circuit).

## GATT layout

Advertised name: `KineTape-XXXX` (XXXX = last 2 bytes of MAC, hex uppercase).

| Role    | UUID                                   | Properties     |
|---------|----------------------------------------|----------------|
| Service | `8f1e0000-3c4a-4b7e-9a51-6b2f0c1d7e00` | (advertised)   |
| LIVE    | `8f1e0001-3c4a-4b7e-9a51-6b2f0c1d7e00` | notify         |
| HISTORY | `8f1e0002-3c4a-4b7e-9a51-6b2f0c1d7e00` | notify         |
| CONTROL | `8f1e0003-3c4a-4b7e-9a51-6b2f0c1d7e00` | write (w/ rsp) |
| STATUS  | `8f1e0004-3c4a-4b7e-9a51-6b2f0c1d7e00` | read, notify   |

Firmware should request MTU 247. Web Bluetooth (Chrome/Edge) negotiates ≥ 185 in practice.

## LIVE notification — 12 bytes, sent at 20 Hz while a client is subscribed

| Off | Type | Field                | Notes                                         |
|-----|------|----------------------|-----------------------------------------------|
| 0   | u8   | type                 | `0x10`                                        |
| 1   | u8   | flags                | bit0 contracting, bit1 calibrated, bit2 sensor_ok |
| 2   | u16  | seq                  | wraps at 65535                                |
| 4   | u32  | uptime_ms            |                                               |
| 8   | u16  | raw                  | latest filtered ADC value 0–4095              |
| 10  | u16  | activation_permille  | 0–1000                                        |

## Minute record — 16 bytes

| Off | Type | Field                    | Notes                                                        |
|-----|------|--------------------------|--------------------------------------------------------------|
| 0   | u32  | t                        | if `time_valid`: unix epoch seconds (UTC) at minute start; else seconds since boot |
| 4   | u16  | boot_id                  | increments every power-up (persisted in NVS)                 |
| 6   | u8   | flags                    | bit0 time_valid, bit1 sensor_ok (for the whole minute)       |
| 7   | u8   | reserved                 | 0                                                            |
| 8   | u16  | mean_activation_permille |                                                              |
| 10  | u16  | peak_activation_permille |                                                              |
| 12  | u16  | reps                     | contractions completed in this minute                        |
| 14  | u16  | active_seconds           | 0–60, seconds with activation ≥ threshold                    |

Each record has an implicit, monotonically increasing **u32 index** (its position in the log since
last CLEAR, never reused). The ring buffer drops the oldest records when full.

**Unsynced time:** records with `time_valid=0` and `boot_id == STATUS.boot_id` can be converted by the
app: `epoch = STATUS.epoch_now - STATUS.uptime_s + t` (if the app has just set time). Older unsynced
boots are shown as "time unknown" (app may estimate). When CONTROL `SET_TIME` arrives, firmware starts
writing `time_valid=1` records from the next minute on.

## HISTORY notifications (response to `SYNC_HISTORY`)

**RECORDS packet** — `8 + 16*n` bytes:

| Off | Type | Field        | Notes                                   |
|-----|------|--------------|-----------------------------------------|
| 0   | u8   | type         | `0x20`                                  |
| 1   | u8   | count n      | 1..10, and `8+16n ≤ MTU-3`              |
| 2   | u16  | reserved     | 0                                       |
| 4   | u32  | first_index  | index of first record; rest consecutive |
| 8   | ...  | n × record   |                                         |

**END packet** — 8 bytes:

| Off | Type | Field      | Notes                              |
|-----|------|------------|------------------------------------|
| 0   | u8   | type       | `0x21`                             |
| 1   | u8   | status     | 0 ok, 1 error                      |
| 2   | u16  | reserved   | 0                                  |
| 4   | u32  | next_index | index after the last record stored |

Firmware paces packets (≈ 10 ms gap or wait for notify congestion to clear) so none are dropped.

## CONTROL writes — first byte is opcode

| Op   | Name           | Payload after opcode            | Effect                                              |
|------|----------------|---------------------------------|-----------------------------------------------------|
| 0x01 | SET_TIME       | u32 epoch_s, i16 tz_offset_min  | sets RTC; tz stored for local-midnight "today" reps |
| 0x02 | CALIBRATE_REST | —                               | samples 3 s, stores `rest_raw` (NVS)                |
| 0x03 | CALIBRATE_MAX  | —                               | samples 5 s, stores peak as `max_raw` (NVS)         |
| 0x04 | SYNC_HISTORY   | u32 from_index                  | streams RECORDS from `max(from_index, oldest)` then END |
| 0x05 | CLEAR_HISTORY  | —                               | wipes log; indices restart at 0                      |
| 0x06 | SET_THRESHOLD  | u8 threshold_pct (5..95)        | persisted                                           |
| 0x07 | IDENTIFY       | —                               | blinks LED 5× quickly                               |

After every command, firmware sets `last_cmd`/`last_result` in STATUS and **notifies STATUS**.
Calibration is async: `calib_state` goes 1/2 while sampling, back to 0 when done (STATUS notified at
start and end). `last_result`: 0 ok, 1 bad_args, 2 busy, 3 unknown_opcode, 4 failed
(e.g. CALIBRATE_MAX peak not at least 100 above rest_raw).

## STATUS — 32 bytes (read, and notified on change / every 5 s)

| Off | Type | Field            | Notes                                                    |
|-----|------|------------------|----------------------------------------------------------|
| 0   | u8   | type             | `0x30`                                                   |
| 1   | u8   | fw_version       | 1                                                        |
| 2   | u8   | flags            | bit0 time_valid, bit1 calibrated, bit2 sensor_ok         |
| 3   | u8   | calib_state      | 0 idle, 1 sampling rest, 2 sampling max                  |
| 4   | u32  | epoch_now        | 0 if time not set                                        |
| 8   | u32  | uptime_s         |                                                          |
| 12  | u16  | boot_id          |                                                          |
| 14  | u16  | rest_raw         |                                                          |
| 16  | u16  | max_raw          |                                                          |
| 18  | u8   | threshold_pct    |                                                          |
| 19  | u8   | battery_pct      | 255 = unknown (MVP has no battery sense)                 |
| 20  | u32  | oldest_index     |                                                          |
| 24  | u32  | next_index       | stored count = next_index − oldest_index                 |
| 28  | u8   | last_cmd         | opcode of last CONTROL write, 0 if none                  |
| 29  | u8   | last_result      | see above                                                |
| 30  | u16  | reps_today       | since local midnight if time valid, else since boot      |

## Typical app session

1. Connect, subscribe STATUS/HISTORY/LIVE, read STATUS.
2. Write `SET_TIME` (now, browser tz offset).
3. Write `SYNC_HISTORY(last_synced_next_index)` → collect RECORDS until END → persist `next_index`.
   If STATUS.next_index < stored cursor (device was cleared/reflashed), resync from 0.
4. Stream LIVE for the live view / guided exercise sessions.
