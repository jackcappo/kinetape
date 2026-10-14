// KineTape firmware entry point.
//
// Tasks:  sensor (core 1, prio 5, 100 Hz)   logger (core 0, prio 1, flash writes)
//         control (core 0, prio 2)          ble_tx (core 0, prio 3, LIVE/STATUS)
//         led (core 0, prio 1)              Arduino loop(): serial console + 1 Hz debug line
#include <Arduino.h>

#include "ble_service.h"
#include "clock.h"
#include "control.h"
#include "led.h"
#include "minute_log.h"
#include "protocol.h"
#include "sensor.h"
#include "settings.h"

namespace {

bool g_print = true;
char line[64];
size_t line_len = 0;

void print_help() {
  Serial.println(
      "commands:\n"
      "  help                 this text\n"
      "  sim on|off           synthetic contraction waveform instead of the ADC\n"
      "  stat                 full status dump\n"
      "  quiet                toggle the 1 Hz debug line\n"
      "  rest | max           CALIBRATE_REST (3 s) / CALIBRATE_MAX (5 s)\n"
      "  thr <5..95>          SET_THRESHOLD\n"
      "  time <epoch> [tz]    SET_TIME (tz offset in minutes, e.g. -240)\n"
      "  id                   IDENTIFY (blink LED)\n"
      "  dump [n]             print the newest n minute records (default 10)\n"
      "  clear                CLEAR_HISTORY\n"
      "  reboot               restart the ESP32");
}

void print_stat() {
  SensorSnapshot s = sensor_snapshot();
  uint8_t st[kt::STATUS_LEN];
  control_build_status(st);
  Serial.printf("name=%s boot_id=%u uptime=%us time_valid=%d epoch=%u tz=%d\n", ble_name(),
                kt::get_u16(st + 12), (unsigned)clock_uptime_s(), clock_valid(),
                (unsigned)clock_epoch_now(), clock_tz());
  Serial.printf("adc=%u filt=%u act=%u contracting=%d sensor_ok=%d sim=%d\n", s.adc, s.filtered,
                s.activation, s.contracting, s.sensor_ok, s.sim);
  Serial.printf("rest_raw=%u max_raw=%u calibrated=%d baseline_ready=%d calib_state=%u thr=%u%%\n",
                s.rest_raw, s.max_raw, s.calibrated, s.baseline_ready, s.calib_state, s.threshold_pct);
  Serial.printf("reps_since_boot=%u reps_today=%u minute_reps=%u\n", (unsigned)s.reps_since_boot,
                s.reps_today, s.minute_reps);
  Serial.printf("log oldest=%u next=%u stored=%u cap=%u dropped=%u\n", (unsigned)minute_log::oldest(),
                (unsigned)minute_log::next(), (unsigned)(minute_log::next() - minute_log::oldest()),
                (unsigned)minute_log::CAPACITY, (unsigned)minute_log::dropped());
  Serial.printf("ble connected=%d mtu=%u last_cmd=0x%02X last_result=%u samples=%u overruns=%u\n",
                ble_connected(), ble_mtu(), control_last_cmd(), control_last_result(),
                (unsigned)s.samples, (unsigned)s.overruns);
  Serial.print("STATUS hex=");
  for (size_t i = 0; i < sizeof(st); i++) Serial.printf("%02x", st[i]);
  Serial.println();
}

void dump(int n) {
  if (n < 1) n = 1;
  if (n > 60) n = 60;
  uint32_t nx = minute_log::next(), ol = minute_log::oldest();
  uint32_t from = nx - ol > (uint32_t)n ? nx - (uint32_t)n : ol;
  uint8_t buf[kt::RECORD_LEN * 10];
  while (from < nx) {
    uint32_t first;
    int got = minute_log::read_raw(from, buf, 10, &first);
    if (got <= 0) break;
    for (int i = 0; i < got; i++) {
      kt::MinuteRecord r;
      kt::decode_record(buf + i * kt::RECORD_LEN, &r);
      Serial.printf("#%u t=%u boot=%u flags=%u mean=%u peak=%u reps=%u active_s=%u\n",
                    (unsigned)(first + i), (unsigned)r.t, r.boot_id, r.flags,
                    r.mean_activation_permille, r.peak_activation_permille, r.reps, r.active_seconds);
    }
    from = first + (uint32_t)got;
  }
}

void submit_simple(uint8_t op) {
  uint8_t b[1];
  kt::encode_simple_op(op, b);
  control_submit(b, 1);
}

void run_command(char* cmd) {
  while (*cmd == ' ') cmd++;
  char* arg = strchr(cmd, ' ');
  if (arg) {
    *arg++ = 0;
    while (*arg == ' ') arg++;
  }
  if (!strcmp(cmd, "help") || !strcmp(cmd, "?")) {
    print_help();
  } else if (!strcmp(cmd, "sim")) {
    bool on = arg && !strcmp(arg, "on");
    sensor_set_sim(on);
    Serial.printf("sim %s\n", on ? "ON (synthetic waveform)" : "OFF (ADC)");
  } else if (!strcmp(cmd, "stat")) {
    print_stat();
  } else if (!strcmp(cmd, "quiet")) {
    g_print = !g_print;
  } else if (!strcmp(cmd, "rest")) {
    submit_simple(kt::OP_CALIBRATE_REST);
  } else if (!strcmp(cmd, "max")) {
    submit_simple(kt::OP_CALIBRATE_MAX);
  } else if (!strcmp(cmd, "thr") && arg) {
    uint8_t b[2];
    kt::encode_set_threshold((uint8_t)atoi(arg), b);
    control_submit(b, 2);
  } else if (!strcmp(cmd, "time") && arg) {
    char* end = nullptr;
    uint32_t epoch = strtoul(arg, &end, 10);
    int tz = (end && *end) ? atoi(end) : 0;
    uint8_t b[7];
    kt::encode_set_time(epoch, (int16_t)tz, b);
    control_submit(b, 7);
  } else if (!strcmp(cmd, "id")) {
    submit_simple(kt::OP_IDENTIFY);
  } else if (!strcmp(cmd, "dump")) {
    dump(arg ? atoi(arg) : 10);
  } else if (!strcmp(cmd, "clear")) {
    submit_simple(kt::OP_CLEAR_HISTORY);
  } else if (!strcmp(cmd, "reboot")) {
    Serial.println("rebooting...");
    delay(100);
    ESP.restart();
  } else if (*cmd) {
    Serial.printf("unknown command '%s' (try 'help')\n", cmd);
  }
}

void poll_serial() {
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\r' || ch == '\n') {
      if (line_len) {
        line[line_len] = 0;
        run_command(line);
        line_len = 0;
      }
    } else if (line_len < sizeof(line) - 1) {
      line[line_len++] = ch;
    }
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== KineTape firmware v1 ===");

  settings_begin();
  Settings s = settings_get();
  Serial.printf("boot_id=%u thr=%u%% rest=%s max=%s tz=%d\n", s.boot_id, s.threshold_pct,
                s.rest_cal ? String(s.rest_raw).c_str() : "auto", s.max_cal ? String(s.max_raw).c_str() : "4095",
                s.tz_offset_min);

  clock_init(s.tz_offset_min);
  minute_log::begin();
  Serial.printf("log: oldest=%u next=%u capacity=%u\n", (unsigned)minute_log::oldest(),
                (unsigned)minute_log::next(), (unsigned)minute_log::CAPACITY);
  sensor_begin(s.boot_id);
  control_begin(s.boot_id);
  ble_begin(control_submit, control_build_status);
  led_begin();
  Serial.println("type 'help' for serial commands");
}

void loop() {
  static uint32_t last = 0;
  poll_serial();
  uint32_t now = millis();
  if (now - last >= 1000) {
    last = now;
    if (g_print) {
      SensorSnapshot s = sensor_snapshot();
      Serial.printf("t=%us raw=%u filt=%u act=%u%s reps=%u today=%u ok=%d%s%s%s\n",
                    (unsigned)clock_uptime_s(), s.adc, s.filtered, s.activation,
                    s.contracting ? " [C]" : "", (unsigned)s.reps_since_boot, s.reps_today,
                    s.sensor_ok, s.sim ? " sim" : "", s.calib_state ? " calibrating" : "",
                    ble_connected() ? " ble" : "");
    }
  }
  delay(10);
}
