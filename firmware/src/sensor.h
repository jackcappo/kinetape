// 100 Hz sampling task: ADC (or simulator) -> EMA -> activation -> hysteresis
// rep detection, sensor_ok detection, calibration state machine, minute
// summaries (posted to minute_log, never written from this task).
#pragma once
#include <stdint.h>

constexpr int SENSOR_PIN = 34;  // ADC1_CH6
constexpr uint32_t SAMPLE_HZ = 100;

struct SensorSnapshot {
  uint16_t adc;         // latest raw ADC sample 0..4095 (before EMA)
  uint16_t filtered;    // EMA-filtered value (rounded) - the LIVE "raw" field
  uint16_t activation;  // permille
  bool contracting;
  bool sensor_ok;
  bool calibrated;      // rest AND max calibrated
  bool baseline_ready;  // false during the first 2 s if rest is uncalibrated
  uint8_t calib_state;  // kt::CALIB_*
  uint16_t rest_raw;
  uint16_t max_raw;
  uint8_t threshold_pct;
  uint32_t reps_since_boot;
  uint16_t reps_today;
  uint16_t minute_reps;  // reps in the current (unfinished) minute
  bool sim;
  uint32_t samples;      // total samples since boot
  uint32_t overruns;     // sample periods missed
};

struct CalibResult {
  uint8_t kind;  // kt::CALIB_REST or kt::CALIB_MAX
  bool ok;
  uint16_t value;  // measured rest mean / max peak
  bool max_reset;  // REST only: old max_raw no longer >= rest+100, reset to 4095
};

void sensor_begin(uint16_t boot_id);
SensorSnapshot sensor_snapshot();

// Returns false if a calibration is already running.
bool sensor_start_calibration(uint8_t kind);
// Pops a finished calibration result (already applied in RAM). Non-blocking.
bool sensor_take_calibration_result(CalibResult* out);

void sensor_set_threshold(uint8_t pct);
void sensor_set_sim(bool on);
// reps_today = reps_since_boot + offset (offset recomputed on SET_TIME / midnight).
void sensor_set_reps_today_offset(int32_t offset);
