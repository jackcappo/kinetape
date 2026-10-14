#include "control.h"

#include <Arduino.h>

#include "ble_service.h"
#include "clock.h"
#include "led.h"
#include "minute_log.h"
#include "protocol.h"
#include "sensor.h"
#include "settings.h"

namespace {

struct Msg {
  uint8_t len;  // true write length, saturated at 255
  uint8_t data[15];
};

QueueHandle_t q;
uint16_t g_boot_id = 0;
volatile uint8_t g_last_cmd = kt::OP_NONE;
volatile uint8_t g_last_result = kt::RESULT_OK;

void finish(uint8_t op, uint8_t result) {
  g_last_cmd = op;
  g_last_result = result;
  ble_request_status_notify();
  Serial.printf("[ctrl] op=0x%02X result=%u\n", op, result);
}

// reps_today = reps_since_boot + offset; see README "Protocol notes".
void recompute_reps_today() {
  if (!clock_valid()) return;
  uint32_t epoch = clock_epoch_now();
  int16_t tz = clock_tz();
  int64_t midnight = clock_local_midnight_utc(epoch, tz);
  uint32_t before = 0, other = 0;
  if (!minute_log::sum_reps_for_today(g_boot_id, clock_boot_epoch(), midnight, &before, &other)) {
    Serial.println("[ctrl] reps_today recompute: log read failed");
    return;
  }
  sensor_set_reps_today_offset((int32_t)other - (int32_t)before);
  Serial.printf("[ctrl] reps_today recomputed (before_midnight=%u, other_boots_today=%u)\n",
                (unsigned)before, (unsigned)other);
}

void poll_calibration() {
  CalibResult r;
  if (!sensor_take_calibration_result(&r)) return;
  if (r.kind == kt::CALIB_REST) {
    settings_save_rest(r.value);
    if (r.max_reset) settings_clear_max();
    Serial.printf("[cal] rest_raw=%u%s\n", r.value, r.max_reset ? " (max_raw reset to 4095)" : "");
    finish(kt::OP_CALIBRATE_REST, kt::RESULT_OK);
  } else {
    if (r.ok) settings_save_max(r.value);
    Serial.printf("[cal] max peak=%u -> %s\n", r.value, r.ok ? "stored" : "FAILED (< rest+100)");
    finish(kt::OP_CALIBRATE_MAX, r.ok ? kt::RESULT_OK : kt::RESULT_FAILED);
  }
}

void handle(const Msg& m, bool streaming);

void stream_history(uint32_t from_index) {
  if (!ble_history_subscribed()) {
    finish(kt::OP_SYNC_HISTORY, kt::RESULT_FAILED);
    return;
  }
  const uint8_t per = kt::records_per_packet(ble_mtu());
  uint32_t idx = from_index;
  if (idx < minute_log::oldest()) idx = minute_log::oldest();
  if (idx > minute_log::next()) idx = minute_log::next();
  uint8_t status = 0;
  uint32_t sent = 0;
  uint32_t t0 = millis();
  static uint8_t recs[kt::RECORD_LEN * kt::HISTORY_MAX_RECORDS];
  static uint8_t pkt[kt::HISTORY_MAX_LEN];

  if (per == 0) {
    status = 1;  // MTU too small for even one record
  } else {
    for (;;) {
      // Stay responsive while streaming (SYNC/CLEAR answer BUSY).
      Msg m;
      while (xQueueReceive(q, &m, 0) == pdTRUE) handle(m, true);
      poll_calibration();

      uint32_t first = idx;
      int got = minute_log::read_raw(idx, recs, per, &first);
      if (got < 0) {
        status = 1;
        break;
      }
      if (got == 0) {
        idx = first;
        break;
      }
      size_t len = kt::encode_history_records_raw(first, recs, (uint8_t)got, pkt);
      if (!ble_send_history(pkt, len)) {
        Serial.println("[sync] aborted (disconnected/unsubscribed)");
        finish(kt::OP_SYNC_HISTORY, kt::RESULT_FAILED);
        return;
      }
      idx = first + (uint32_t)got;
      sent += (uint32_t)got;
      vTaskDelay(pdMS_TO_TICKS(10));  // pacing per PROTOCOL.md
    }
  }
  uint8_t end[kt::HISTORY_END_LEN];
  kt::encode_history_end(status, idx, end);
  bool ok = ble_send_history(end, sizeof(end));
  Serial.printf("[sync] %u records, %u/pkt (mtu %u), next_index=%u, %lu ms, status=%u\n",
                (unsigned)sent, per, ble_mtu(), (unsigned)idx, (unsigned long)(millis() - t0), status);
  finish(kt::OP_SYNC_HISTORY, (ok && status == 0) ? kt::RESULT_OK : kt::RESULT_FAILED);
}

void handle(const Msg& m, bool streaming) {
  kt::ControlCmd c;
  kt::ParseStatus p = kt::parse_control(m.data, m.len, &c);
  if (p != kt::PARSE_OK) {
    finish(c.opcode, (uint8_t)p);
    return;
  }
  switch (c.opcode) {
    case kt::OP_SET_TIME:
      clock_set(c.epoch_s, c.tz_offset_min);
      settings_save_tz(c.tz_offset_min);
      recompute_reps_today();
      finish(c.opcode, kt::RESULT_OK);
      break;
    case kt::OP_CALIBRATE_REST:
    case kt::OP_CALIBRATE_MAX: {
      uint8_t kind = c.opcode == kt::OP_CALIBRATE_REST ? kt::CALIB_REST : kt::CALIB_MAX;
      if (!sensor_start_calibration(kind)) {
        finish(c.opcode, kt::RESULT_BUSY);
      } else {
        Serial.printf("[cal] sampling %s...\n", kind == kt::CALIB_REST ? "rest (3 s)" : "max (5 s)");
        finish(c.opcode, kt::RESULT_OK);  // accepted; final result on completion
      }
      break;
    }
    case kt::OP_SYNC_HISTORY:
      if (streaming) finish(c.opcode, kt::RESULT_BUSY);
      else stream_history(c.from_index);
      break;
    case kt::OP_CLEAR_HISTORY:
      if (streaming) finish(c.opcode, kt::RESULT_BUSY);
      else finish(c.opcode, minute_log::clear() ? kt::RESULT_OK : kt::RESULT_FAILED);
      break;
    case kt::OP_SET_THRESHOLD:
      sensor_set_threshold(c.threshold_pct);
      settings_save_threshold(c.threshold_pct);
      finish(c.opcode, kt::RESULT_OK);
      break;
    case kt::OP_IDENTIFY:
      led_identify();
      finish(c.opcode, kt::RESULT_OK);
      break;
    default:
      finish(c.opcode, kt::RESULT_UNKNOWN_OPCODE);
      break;
  }
}

void control_task(void*) {
  Msg m;
  for (;;) {
    if (xQueueReceive(q, &m, pdMS_TO_TICKS(50)) == pdTRUE) handle(m, false);
    poll_calibration();
  }
}

}  // namespace

void control_begin(uint16_t boot_id) {
  g_boot_id = boot_id;
  q = xQueueCreate(8, sizeof(Msg));
  xTaskCreatePinnedToCore(control_task, "control", 6144, nullptr, 2, nullptr, 0);
}

void control_submit(const uint8_t* data, size_t len) {
  Msg m = {};
  m.len = len > 255 ? 255 : (uint8_t)len;
  memcpy(m.data, data, len < sizeof(m.data) ? len : sizeof(m.data));
  if (xQueueSend(q, &m, 0) != pdTRUE) finish(len ? data[0] : kt::OP_NONE, kt::RESULT_BUSY);
}

void control_build_status(uint8_t* out) {
  SensorSnapshot s = sensor_snapshot();
  kt::StatusPacket p;
  bool tv = clock_valid();
  p.fw_version = kt::FW_VERSION;
  p.flags = (tv ? kt::STATUS_FLAG_TIME_VALID : 0) | (s.calibrated ? kt::STATUS_FLAG_CALIBRATED : 0) |
            (s.sensor_ok ? kt::STATUS_FLAG_SENSOR_OK : 0);
  p.calib_state = s.calib_state;
  p.uptime_s = clock_uptime_s();
  // epoch_now - uptime_s is exactly the boot epoch, so the app's conversion of
  // unsynced records (epoch_now - uptime_s + t) never jitters by a second.
  p.epoch_now = tv ? (uint32_t)(clock_boot_epoch() + (int64_t)p.uptime_s) : 0;
  p.boot_id = g_boot_id;
  p.rest_raw = s.rest_raw;
  p.max_raw = s.max_raw;
  p.threshold_pct = s.threshold_pct;
  p.battery_pct = kt::BATTERY_UNKNOWN;
  p.oldest_index = minute_log::oldest();
  p.next_index = minute_log::next();
  p.last_cmd = g_last_cmd;
  p.last_result = g_last_result;
  p.reps_today = s.reps_today;
  kt::encode_status(p, out);
}

uint8_t control_last_cmd() { return g_last_cmd; }
uint8_t control_last_result() { return g_last_result; }
