# KineTape firmware (ESP32)

Firmware for KineTape: kinesiology tape with an embedded ZD10-100 thin-film pressure
sensor that logs muscle activity all day for physical-therapy recovery (e.g. ACL rehab).
The web app talks to it only over BLE, per [`../PROTOCOL.md`](../PROTOCOL.md) (binding
contract) and [`../protocol/test-vectors.json`](../protocol/test-vectors.json).

## Layout

| File | Role |
|---|---|
| `platformio.ini` | env `esp32dev` (Arduino, espressif32 6.9.0, NimBLE-Arduino ~1.4.2 → 1.4.3), env `native` (host unit test) |
| `src/protocol.h` | Header-only, Arduino-free packing/unpacking. Explicit little-endian byte writes, `static_assert`s on every wire size. |
| `src/sensor.{h,cpp}` | 100 Hz FreeRTOS task (core 1): ADC or simulator → EMA(0.2) → activation ‰ → hysteresis reps, `sensor_ok`, calibration state machine, minute accumulators |
| `src/minute_log.{h,cpp}` | LittleFS ring log of 16-byte records, 16384 records (11.4 days), persistent oldest/next index, CLEAR. Flash I/O in its own task, fed by a queue. |
| `src/ble_service.{h,cpp}` | GATT server, MTU 247 request, LIVE 20 Hz (only while subscribed), STATUS on change + every 5 s, paced HISTORY notifications, advertising restart |
| `src/control.{h,cpp}` | CONTROL command task, SYNC_HISTORY streaming, STATUS assembly |
| `src/clock.{h,cpp}` | Epoch from SET_TIME on top of the 64-bit esp_timer, `time_valid`, local-day math for `reps_today` |
| `src/settings.{h,cpp}` | NVS (Preferences): boot_id, rest/max calibration, threshold, tz offset |
| `src/led.{h,cpp}` | GPIO2 status LED |
| `src/main.cpp` | Setup, serial console, 1 Hz debug line |
| `test/test_protocol/test_protocol.cpp` | Unity test: every vector in `test-vectors.json` plus parser/MTU edge cases |

Task layout: `sensor` (core 1, prio 5) never touches flash or BLE; it posts finished minute
records to the `logger` task's queue and publishes a snapshot under a spinlock. `control`
(core 0) handles commands and history streaming, `ble_tx` (core 0) sends LIVE/STATUS.

## Wiring

```
        ESP32 DevKit                     ZD10-100 (thin-film FSR)
     +----------------+
     |            3V3 |-----------------o  sensor lead A
     |                |                    (polarity doesn't matter)
     |  GPIO34 (ADC1) |--------+--------o  sensor lead B
     |                |        |
     |                |      [10kΩ]   pull-down: more pressure -> lower
     |                |        |      sensor R -> higher voltage -> higher ADC
     |            GND |--------+
     |                |
     |   GPIO2 (LED)  |  onboard blue LED (status)
     |   USB          |  power + serial 115200
     +----------------+

  V(GPIO34) = 3.3 V * 10k / (10k + R_sensor)
  Optional: 100 nF from GPIO34 to GND right at the board to reduce noise.
```

GPIO34 is input-only ADC1 (works while BLE is on; ADC2 pins do not). 11 dB attenuation
is used (≈0–3.1 V full scale).

## Placement on the tape (ACL rehab)

- Put the sensor pad over the **vastus medialis oblique (VMO)**, the teardrop-shaped bulge of
  the quadriceps just above and medial to the kneecap (≈ 3–5 cm above the superior-medial
  edge of the patella). VMO activation is the classic early ACL-rehab target (quad sets,
  straight-leg raises, terminal knee extension).
- Sandwich the sensor between two layers of tape, active face toward the skin, with the tape
  applied at light (≈ 10–25 %) tension so the muscle belly bulging during a contraction
  presses into the film. Route the leads up the thigh away from the knee crease.
- Avoid the patella and the joint line (flexion bends the film and creates false readings).
- Recalibrate (below) every time the tape is re-applied.

## Build / flash

PlatformIO via Python (Windows: `py`, not `python`):

```
py -m pip install --user platformio
py -m platformio run   -d firmware                  # compile (env esp32dev)
py -m platformio run   -d firmware -t upload        # flash over USB
py -m platformio device monitor -d firmware         # serial console @115200
py -m platformio test  -d firmware -e esp32dev      # run unit test on the board
py -m platformio test  -d firmware -e native        # run unit test on the host (needs host gcc)
```

For the `native` test on Windows without gcc, PlatformIO's MinGW package works:
`py -m platformio pkg install -g -t platformio/toolchain-gccmingw32`, then put
`%USERPROFILE%\.platformio\packages\toolchain-gccmingw32\bin` on `PATH`.

The first boot formats LittleFS (data partition "spiffs" from `default.csv`, ~1.4 MB).
`pio run -t erase` wipes everything (log, boot_id, calibration).

## Calibration procedure

Uncalibrated, `rest_raw` = mean of the first 2 s after boot and `max_raw` = 4095 (so
activation values are low but usable). For real numbers:

1. Apply the tape, sit with the leg relaxed and supported (knee slightly bent).
2. **CALIBRATE_REST** (app button, or serial `rest`): stay relaxed for 3 s. STATUS shows
   `calib_state=1`, then 0 with `last_cmd=2,last_result=0`. Stored in NVS.
3. **CALIBRATE_MAX** (app or serial `max`): within 5 s do a maximal quad set (press the back
   of the knee down, tighten the thigh) and hold ~2 s. `calib_state=2` → 0. If the peak is
   not at least 100 counts above `rest_raw`, `last_result=4` (failed) and nothing is stored -
   check sensor placement and try again.
4. Optional: **SET_THRESHOLD** (default 30 %): a contraction starts at ≥ threshold, ends below
   0.6×threshold, and counts as a rep if it lasted ≥ 200 ms. Early post-op patients may need
   15–20 %.

STATUS `calibrated` = both REST and MAX have been stored. A new REST that ends up within
100 counts of the stored MAX resets MAX to 4095 (uncalibrated).

## Serial console (115200 baud, line-terminated)

One line per second: `t=… raw=<adc> filt=<ema> act=<‰> [C] reps=<since boot> today=<reps_today> ok=<sensor_ok> [sim] [calibrating] [ble]`

| Command | Effect |
|---|---|
| `help` | list commands |
| `sim on` / `sim off` | feed a synthetic waveform instead of the ADC: 1.6 s contraction every 5 s, every 4th one weak (sub-threshold) - bench testing with no sensor wired |
| `stat` | full dump incl. the STATUS bytes in hex |
| `quiet` | toggle the 1 Hz line |
| `rest` / `max` | CALIBRATE_REST / CALIBRATE_MAX |
| `thr <5..95>` | SET_THRESHOLD |
| `time <epoch> [tz_min]` | SET_TIME (e.g. `time 1760000000 -240`) |
| `id` | IDENTIFY |
| `dump [n]` | print newest n (≤ 60) minute records |
| `clear` | CLEAR_HISTORY |
| `reboot` | restart |

Serial commands go through the same CONTROL path as BLE writes, so they also update
`last_cmd`/`last_result`. Bench test without hardware: `sim on`, wait ~1 min, `dump`.

## LED

Slow blink (200 ms flash every 2 s) = advertising; solid = connected; 5 fast blinks = IDENTIFY.

## Power notes

- MVP is powered from USB or a 1S LiPo into the DevKit's 5V/VIN pin (via its regulator).
  Current draw is roughly 40–100 mA with BLE advertising/connected and the CPU at 240 MHz,
  i.e. ~10–20 h from a 1000 mAh cell. No battery measurement: STATUS `battery_pct` = 255.
- No RTC battery: the clock is lost at power-off, so records are `time_valid=0` until the app
  sends SET_TIME (the app converts current-boot records via `epoch_now - uptime_s + t`).
- Future: battery sense via a 100k/100k divider on an ADC1 pin (e.g. GPIO35) → real
  `battery_pct`; light sleep between samples / lower CPU clock (80 MHz), longer advertising
  interval when idle; deep sleep when the sensor reads `!sensor_ok` (tape off) for a long
  time, waking on a timer or touch; keeping time across deep sleep with the RTC.
- Flash writes (one 16 B record per minute) briefly stall both cores; the 100 Hz sampler
  catches up immediately (`stat` shows `overruns`).

## Protocol notes

Interpretations where PROTOCOL.md left room. PROTOCOL.md is unchanged; these are the most
literal readings I could make.

1. **CONTROL length is strict.** The write length must equal opcode + payload exactly
   (SET_TIME 7, SYNC_HISTORY 5, SET_THRESHOLD 2, others 1); otherwise `last_result=1`
   (bad_args). An empty write gives `last_cmd=0,last_result=1`. Unknown opcode:
   `last_cmd=<opcode>,last_result=3`. If the 8-deep command queue is full: `2` (busy).
2. **SET_TIME validation:** `epoch_s == 0` or `tz_offset_min` outside ±840 → bad_args.
   Time is not persisted across power cycles.
3. **SET_TIME mid-minute:** the in-progress unsynced minute (`time_valid=0`, `t` = seconds
   since boot, multiples of 60) runs its normal 60 s. The next record is `time_valid=1`
   with `t` = start of the wall-clock minute it falls in, so that first synced record is
   a partial minute. After that, records are wall-aligned (`t % 60 == 0`). Re-sending SET_TIME
   while time is valid re-aligns the current minute to the new clock (if the clock moves
   backwards, two records can have the same `t`).
4. **Unsynced `t`** is seconds since boot at minute start (0, 60, 120, …). STATUS
   `epoch_now` is computed as `boot_epoch + uptime_s`, so `epoch_now - uptime_s` is
   constant within a boot and the app's conversion never jitters by 1 s.
5. **Minute fields:** `mean` = rounded mean of all 100 Hz activation samples in the minute;
   `peak` = max sample; `active_seconds` = round(samples with activation ≥ threshold_pct×10
   / 100), clamped to 60; `reps` = reps whose contraction *ended* in that minute;
   `flags.bit1 sensor_ok` = sensor_ok held on every sample of the minute.
6. **Rep timing:** duration = samples from the one that crossed `threshold_pct×10` to the
   one that dropped below `threshold_pct×6`; ≥ 20 samples (200 ms) counts.
7. **sensor_ok** uses the raw ADC value (4× oversampled average of `analogRead`): false after
   > 200 consecutive samples (> 2 s) ≤ 5 or ≥ 4090; true again on the first in-range sample.
8. **Calibration:** both use the EMA-filtered value; REST stores the 3 s mean, MAX the 5 s peak.
   On accept: `last_cmd=op,last_result=0`, `calib_state=1|2`, STATUS notified. On
   completion: `calib_state=0`, `last_cmd=op`, `last_result=0` or `4`, STATUS notified
   again. A CALIBRATE_* while one is running → `2` busy. REST always succeeds.
   `calibrated` flag = REST **and** MAX stored.
9. **First 2 s after boot** (when REST was never calibrated): activation is reported as 0
   and STATUS `rest_raw` = 0 until the boot baseline is measured.
10. **SYNC_HISTORY:**
    - Records per packet n = min(10, ⌊(MTU − 3 − 8) / 16⌋) using the negotiated ATT MTU
      (10 at MTU ≥ 171). If n = 0 (MTU < 27), only END with `status=1` is sent.
    - Starts at `max(from_index, oldest)`; if `from_index > next_index`, nothing is sent and
      END carries the current `next_index`.
    - END `next_index` = the index after the last record actually sent. That equals
      STATUS `next_index` unless a new minute was appended during the stream; the app should
      just store END's value as its cursor.
    - HISTORY must be subscribed before SYNC_HISTORY; if not, nothing is sent and
      `last_result=4`. Flash read error → END `status=1`, `last_result=4`.
    - `last_cmd=4` / `last_result` is set and STATUS notified **after** END is sent.
    - Pacing: 10 ms between packets plus retry (every 20 ms, ≤ 2 s) if the BLE stack is out of
      buffers, so packets are not dropped. A full 16384-record log is ~1640 packets ≈ 20 s.
    - While streaming, other commands are still processed; SYNC_HISTORY / CLEAR_HISTORY
      answer `2` (busy).
11. **Ring log:** capacity 16384 records (≥ 7 days requirement → 11.4 days). When full, each
    append drops exactly one oldest record (`oldest_index` += 1). Indices restart at 0 only on
    CLEAR (or a full flash erase).
12. **reps_today:** with time invalid = reps since boot. When SET_TIME arrives the firmware
    scans the log: reps of current-boot records whose (converted) time is before local
    midnight are subtracted, reps of `time_valid` records from earlier boots that are after
    local midnight are added. At each local-midnight minute boundary it resets to 0.
    Saturates at 65535.
13. **STATUS notify:** checked every 100 ms; "changed" ignores `epoch_now` and `uptime_s`
    (which tick every second); otherwise notified at least every 5 s while subscribed, and
    right after every command. STATUS is 32 bytes, so a **notification needs ATT MTU ≥ 35**
    (reads work at any MTU via long read). The firmware requests 247 on connect.
14. **LIVE:** `raw` = EMA-filtered value rounded; `seq` increments per LIVE packet actually
    sent and is not reset between connections; only sent while LIVE notifications are
    enabled.
15. **Name:** `KineTape-XXXX` from the last 2 bytes of the **Bluetooth** MAC
    (`esp_read_mac(ESP_MAC_BT)`), uppercase hex. The 128-bit service UUID is in the
    advertising packet; the name is in the scan response.
16. **boot_id** starts at 1 on the first boot after a flash erase and is never 0 afterwards
    (wraps after 65535 boots).

## Things the app team should know

- The ZD10-100 is > 10 MΩ when unloaded, so with no tape pressure at all the ADC reads ≈ 0 and
  `sensor_ok` goes false after 2 s even though nothing is broken. On a properly taped muscle
  there is usually some baseline pressure; if users see `sensor_ok=0` while relaxed, tell
  them to re-tape a bit firmer rather than treating it as a hardware fault.
- Subscribe to STATUS and HISTORY **before** writing SYNC_HISTORY.
- Persist END.next_index as the sync cursor; if STATUS.next_index < cursor, resync from 0.
- Partial minutes exist (first record after boot, first record after SET_TIME): don't
  assume every record covers 60 s of data.
