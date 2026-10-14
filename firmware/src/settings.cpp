#include "settings.h"

#include <Arduino.h>
#include <Preferences.h>

namespace {
Preferences prefs;
Settings cur;
SemaphoreHandle_t mtx;

struct Lock {
  Lock() { xSemaphoreTake(mtx, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(mtx); }
};
}  // namespace

void settings_begin() {
  mtx = xSemaphoreCreateMutex();
  Lock l;
  prefs.begin("kinetape", false);
  cur.boot_id = (uint16_t)(prefs.getUShort("boot_id", 0) + 1);
  prefs.putUShort("boot_id", cur.boot_id);
  cur.rest_cal = prefs.getBool("rest_cal", false);
  cur.rest_raw = prefs.getUShort("rest_raw", 0);
  cur.max_cal = prefs.getBool("max_cal", false);
  cur.max_raw = prefs.getUShort("max_raw", 4095);
  cur.threshold_pct = prefs.getUChar("thr", 30);
  if (cur.threshold_pct < 5 || cur.threshold_pct > 95) cur.threshold_pct = 30;
  cur.tz_offset_min = prefs.getShort("tz", 0);
  if (!cur.max_cal) cur.max_raw = 4095;
}

Settings settings_get() {
  Lock l;
  return cur;
}

void settings_save_rest(uint16_t rest_raw) {
  Lock l;
  cur.rest_raw = rest_raw;
  cur.rest_cal = true;
  prefs.putUShort("rest_raw", rest_raw);
  prefs.putBool("rest_cal", true);
}

void settings_save_max(uint16_t max_raw) {
  Lock l;
  cur.max_raw = max_raw;
  cur.max_cal = true;
  prefs.putUShort("max_raw", max_raw);
  prefs.putBool("max_cal", true);
}

void settings_clear_max() {
  Lock l;
  cur.max_raw = 4095;
  cur.max_cal = false;
  prefs.putBool("max_cal", false);
  prefs.putUShort("max_raw", 4095);
}

void settings_save_threshold(uint8_t pct) {
  Lock l;
  cur.threshold_pct = pct;
  prefs.putUChar("thr", pct);
}

void settings_save_tz(int16_t tz) {
  Lock l;
  if (cur.tz_offset_min == tz) return;
  cur.tz_offset_min = tz;
  prefs.putShort("tz", tz);
}
