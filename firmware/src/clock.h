// Wall clock: epoch from CONTROL SET_TIME, anchored to the 64-bit esp_timer.
// Time is not persisted (no RTC battery) -> time_valid=0 after every power-up.
#pragma once
#include <stdint.h>

void clock_init(int16_t tz_offset_min);
void clock_set(uint32_t epoch_s, int16_t tz_offset_min);

bool clock_valid();
uint32_t clock_epoch_now();  // 0 if !valid
uint64_t clock_uptime_us();
uint32_t clock_uptime_ms();  // wraps after ~49 days (LIVE field is u32)
uint32_t clock_uptime_s();
int16_t clock_tz();
// Incremented on every SET_TIME; lets other modules notice time jumps cheaply.
uint32_t clock_generation();
// Epoch at uptime 0 of this boot (only meaningful if valid).
int64_t clock_boot_epoch();

// Local calendar day number (days since 1970-01-01 local) for a UTC epoch.
int32_t clock_local_day(uint32_t epoch_s, int16_t tz_offset_min);
// UTC epoch of the local midnight that starts the day containing epoch_s.
int64_t clock_local_midnight_utc(uint32_t epoch_s, int16_t tz_offset_min);
