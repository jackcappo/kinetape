#include "clock.h"

#include <Arduino.h>
#include <esp_timer.h>

namespace {
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
bool valid = false;
int64_t boot_epoch_us = 0;  // epoch (in us) corresponding to esp_timer == 0
int16_t tz = 0;
volatile uint32_t gen = 0;

int64_t floor_div(int64_t a, int64_t b) {
  int64_t q = a / b;
  if ((a % b != 0) && ((a < 0) != (b < 0))) q--;
  return q;
}
}  // namespace

void clock_init(int16_t tz_offset_min) {
  portENTER_CRITICAL(&mux);
  tz = tz_offset_min;
  valid = false;
  portEXIT_CRITICAL(&mux);
}

void clock_set(uint32_t epoch_s, int16_t tz_offset_min) {
  int64_t now = esp_timer_get_time();
  portENTER_CRITICAL(&mux);
  boot_epoch_us = (int64_t)epoch_s * 1000000LL - now;
  tz = tz_offset_min;
  valid = true;
  gen++;
  portEXIT_CRITICAL(&mux);
}

bool clock_valid() { return valid; }

uint32_t clock_epoch_now() {
  portENTER_CRITICAL(&mux);
  bool v = valid;
  int64_t b = boot_epoch_us;
  portEXIT_CRITICAL(&mux);
  if (!v) return 0;
  return (uint32_t)((b + esp_timer_get_time()) / 1000000LL);
}

uint64_t clock_uptime_us() { return (uint64_t)esp_timer_get_time(); }
uint32_t clock_uptime_ms() { return (uint32_t)(esp_timer_get_time() / 1000LL); }
uint32_t clock_uptime_s() { return (uint32_t)(esp_timer_get_time() / 1000000LL); }

int16_t clock_tz() { return tz; }
uint32_t clock_generation() { return gen; }

int64_t clock_boot_epoch() {
  portENTER_CRITICAL(&mux);
  int64_t b = boot_epoch_us;
  portEXIT_CRITICAL(&mux);
  return floor_div(b, 1000000LL);
}

int32_t clock_local_day(uint32_t epoch_s, int16_t tz_offset_min) {
  return (int32_t)floor_div((int64_t)epoch_s + (int64_t)tz_offset_min * 60, 86400);
}

int64_t clock_local_midnight_utc(uint32_t epoch_s, int16_t tz_offset_min) {
  return (int64_t)clock_local_day(epoch_s, tz_offset_min) * 86400 - (int64_t)tz_offset_min * 60;
}
