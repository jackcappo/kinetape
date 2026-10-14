// Persistent settings in NVS (Preferences): boot_id, calibration, threshold, tz.
#pragma once
#include <stdint.h>

struct Settings {
  uint16_t boot_id;
  uint16_t rest_raw;  // valid if rest_cal
  bool rest_cal;
  uint16_t max_raw;   // valid if max_cal
  bool max_cal;
  uint8_t threshold_pct;
  int16_t tz_offset_min;
};

// Loads settings and increments+persists boot_id (call once at power-up).
void settings_begin();
Settings settings_get();

void settings_save_rest(uint16_t rest_raw);
void settings_save_max(uint16_t max_raw);
void settings_clear_max();
void settings_save_threshold(uint8_t pct);
void settings_save_tz(int16_t tz_offset_min);
