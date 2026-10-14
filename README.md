# KineTape

Athletic tape with an embedded thin-film pressure sensor + ESP32 that tracks muscle activity all day,
to support physical-therapy recovery (ACL reconstruction and similar long rehabs).

**Live app: [kinetape.vercel.app](https://kinetape.vercel.app)** — open in Chrome or Edge (Web Bluetooth), or try Demo mode with no hardware.

| Folder | What |
|---|---|
| [`firmware/`](firmware/README.md) | ESP32 (PlatformIO, Arduino, NimBLE) — sampling, rep detection, minute log, BLE service |
| [`webapp/`](webapp/README.md) | Vite + React + TS web app — Web Bluetooth, live view, dashboards, guided exercises, PT reports |
| [`PROTOCOL.md`](PROTOCOL.md) | BLE protocol v1 — the contract between firmware and app |
| [`protocol/test-vectors.json`](protocol/test-vectors.json) | Byte-exact vectors both sides are tested against |

## Quick start

```bash
# web app (Chrome/Edge; has a Demo mode, no hardware needed)
cd webapp && npm install && npm run dev

# firmware (ESP32 DevKit, sensor: 3V3 — sensor — GPIO34 — 10kΩ — GND)
py -m platformio run -d firmware -t upload
```

Status: MVP. Firmware compiles and passes protocol tests; app passes 86 tests and works end-to-end
against the simulated device. Not yet tested on physical hardware.

*Not a medical device. Insights are general information, not medical advice.*
