#include "sensor.h"

#include <Arduino.h>

#include "clock.h"
#include "minute_log.h"
#include "protocol.h"
#include "settings.h"

namespace {

constexpr float EMA_ALPHA = 0.2f;
constexpr uint32_t BASELINE_SAMPLES = 2 * SAMPLE_HZ;      // first 2 s after boot
constexpr uint32_t CAL_REST_SAMPLES = 3 * SAMPLE_HZ;      // 3 s
constexpr uint32_t CAL_MAX_SAMPLES = 5 * SAMPLE_HZ;       // 5 s
constexpr uint32_t STUCK_SAMPLES = 2 * SAMPLE_HZ;         // > 2 s stuck => !sensor_ok
constexpr uint32_t MIN_REP_SAMPLES = SAMPLE_HZ / 5;       // 200 ms
constexpr uint16_t MAX_ABOVE_REST_MIN = 100;
constexpr int ADC_OVERSAMPLE = 4;

portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
SensorSnapshot pub;  // published copy, guarded by mux

// Inputs from other tasks
volatile uint8_t threshold_pct = 30;
volatile bool sim_on = false;
volatile int32_t reps_offset = 0;
volatile uint8_t calib_req = kt::CALIB_IDLE;
bool result_pending = false;
CalibResult result;

uint16_t boot_id = 0;

// Signal state (sensor task only)
float filtered = 0;
bool have_filtered = false;
uint16_t rest_raw = 0, max_raw = 4095;
bool rest_cal = false, max_cal = false;
bool baseline_ready = false;
uint64_t baseline_sum = 0;
uint32_t baseline_n = 0;
uint32_t stuck_n = 0;
bool sensor_ok = true;
bool contracting = false;
uint32_t contraction_start = 0;
uint32_t reps_since_boot = 0;
uint32_t sample_n = 0;
uint32_t overruns = 0;

uint8_t calib_state = kt::CALIB_IDLE;
uint32_t calib_n = 0;
uint64_t calib_sum = 0;
float calib_peak = 0;

// Minute accumulator
struct MinuteAcc {
  uint32_t start_t;   // epoch (time_valid) or uptime seconds
  bool time_valid;
  bool end_on_wall;   // end_value is an epoch (else uptime seconds)
  uint64_t end_value;
  uint64_t sum;
  uint32_t n;
  uint16_t peak;
  uint16_t reps;
  uint32_t active_n;
  bool ok_all;
} acc;
uint32_t seen_clock_gen = 0;
int32_t last_local_day = INT32_MIN;

uint32_t sim_rng = 0x12345678;

float sim_sample(uint32_t n) {
  // 5 s period: 1.6 s raised-cosine contraction, every 4th one weak (sub-threshold).
  const uint32_t period = 5 * SAMPLE_HZ;
  const uint32_t width = 160;
  uint32_t k = n / period, ph = n % period;
  float base = 450.0f;
  float peak = (k % 4 == 3) ? 1100.0f : 2700.0f;
  float v = base;
  if (ph < width) {
    float x = (float)ph / (float)width;
    v += (peak - base) * 0.5f * (1.0f - cosf(2.0f * (float)PI * x));
  }
  sim_rng = sim_rng * 1664525u + 1013904223u;
  v += (float)((int32_t)(sim_rng >> 24) - 128) * (25.0f / 128.0f);
  if (v < 0) v = 0;
  if (v > 4095) v = 4095;
  return v;
}

uint16_t read_adc() {
  uint32_t s = 0;
  for (int i = 0; i < ADC_OVERSAMPLE; i++) s += analogRead(SENSOR_PIN);
  return (uint16_t)(s / ADC_OVERSAMPLE);
}

void minute_start(uint32_t uptime_s_hint) {
  acc.sum = 0;
  acc.n = 0;
  acc.peak = 0;
  acc.reps = 0;
  acc.active_n = 0;
  acc.ok_all = true;
  if (clock_valid()) {
    uint32_t e = clock_epoch_now();
    acc.start_t = e - (e % 60);
    acc.time_valid = true;
    acc.end_on_wall = true;
    acc.end_value = (uint64_t)acc.start_t + 60;
    // reps_today: reset at local midnight
    int16_t tz = clock_tz();
    int32_t day = clock_local_day(acc.start_t, tz);
    if (last_local_day != INT32_MIN && day != last_local_day) {
      reps_offset = -(int32_t)reps_since_boot;
    }
    last_local_day = day;
  } else {
    acc.start_t = uptime_s_hint;
    acc.time_valid = false;
    acc.end_on_wall = false;
    acc.end_value = (uint64_t)uptime_s_hint + 60;
  }
}

void minute_close() {
  kt::MinuteRecord r;
  r.t = acc.start_t;
  r.boot_id = boot_id;
  r.flags = (acc.time_valid ? kt::REC_FLAG_TIME_VALID : 0) | (acc.ok_all ? kt::REC_FLAG_SENSOR_OK : 0);
  r.mean_activation_permille = acc.n ? (uint16_t)((acc.sum + acc.n / 2) / acc.n) : 0;
  r.peak_activation_permille = acc.peak;
  r.reps = acc.reps;
  uint32_t as = (acc.active_n + SAMPLE_HZ / 2) / SAMPLE_HZ;
  r.active_seconds = (uint16_t)(as > 60 ? 60 : as);
  if (!minute_log::post(r)) Serial.println("[sensor] log queue full, minute dropped");
}

// Handles SET_TIME transitions and decides whether the current minute is over.
void minute_tick() {
  uint32_t gen = clock_generation();
  if (gen != seen_clock_gen) {
    seen_clock_gen = gen;
    uint32_t e = clock_epoch_now();
    uint32_t aligned = e - (e % 60);
    if (!acc.time_valid) {
      // Let this uptime-based (time_valid=0) minute run its normal 60 s; the
      // next minute starts wall-aligned with time_valid=1 (it is a partial
      // minute: t = start of the wall minute it falls in). No record > 60 s.
    } else {
      // Clock re-set while already valid: re-align the current minute.
      acc.start_t = aligned;
      acc.end_value = (uint64_t)aligned + 60;
    }
    last_local_day = clock_local_day(e, clock_tz());
  }
  bool close;
  uint32_t up_s = clock_uptime_s();
  if (acc.end_on_wall) {
    close = clock_epoch_now() >= acc.end_value;
  } else {
    close = up_s >= acc.end_value;
  }
  if (close) {
    uint32_t next_uptime_start = acc.end_on_wall ? up_s : (uint32_t)acc.end_value;
    minute_close();
    minute_start(next_uptime_start);
  }
}

void process_sample(uint16_t adc) {
  sample_n++;
  // sensor_ok: raw stuck at a rail for > 2 s means open/short circuit
  if (adc <= 5 || adc >= 4090) {
    if (stuck_n <= STUCK_SAMPLES) stuck_n++;
  } else {
    stuck_n = 0;
  }
  sensor_ok = stuck_n <= STUCK_SAMPLES;

  if (!have_filtered) {
    filtered = adc;
    have_filtered = true;
  } else {
    filtered += EMA_ALPHA * ((float)adc - filtered);
  }

  // Uncalibrated rest = mean of the first 2 s of raw samples
  if (!baseline_ready) {
    baseline_sum += adc;
    baseline_n++;
    if (baseline_n >= BASELINE_SAMPLES) {
      rest_raw = (uint16_t)(baseline_sum / baseline_n);
      baseline_ready = true;
      Serial.printf("[sensor] boot baseline rest_raw=%u\n", rest_raw);
    }
  }

  // Calibration state machine
  if (calib_state == kt::CALIB_IDLE && calib_req != kt::CALIB_IDLE) {
    calib_state = calib_req;
    calib_n = 0;
    calib_sum = 0;
    calib_peak = 0;
  }
  if (calib_state != kt::CALIB_IDLE) {
    calib_n++;
    calib_sum += (uint64_t)(filtered + 0.5f);
    if (filtered > calib_peak) calib_peak = filtered;
    uint32_t need = calib_state == kt::CALIB_REST ? CAL_REST_SAMPLES : CAL_MAX_SAMPLES;
    if (calib_n >= need) {
      CalibResult res = {};
      res.kind = calib_state;
      if (calib_state == kt::CALIB_REST) {
        res.value = (uint16_t)(calib_sum / calib_n);
        res.ok = true;
        rest_raw = res.value;
        rest_cal = true;
        baseline_ready = true;
        if (max_raw < (uint32_t)rest_raw + MAX_ABOVE_REST_MIN) {
          max_raw = 4095;
          max_cal = false;
          res.max_reset = true;
        }
      } else {
        res.value = (uint16_t)(calib_peak + 0.5f);
        res.ok = res.value >= (uint32_t)rest_raw + MAX_ABOVE_REST_MIN;
        if (res.ok) {
          max_raw = res.value;
          max_cal = true;
        }
      }
      portENTER_CRITICAL(&mux);
      result = res;
      result_pending = true;
      calib_state = kt::CALIB_IDLE;
      calib_req = kt::CALIB_IDLE;
      portEXIT_CRITICAL(&mux);
    }
  }

  uint16_t act = baseline_ready ? kt::activation_permille(filtered, rest_raw, max_raw) : 0;

  // Hysteresis rep detection
  uint8_t thr = threshold_pct;
  uint16_t on = kt::threshold_on_permille(thr);
  uint16_t off = kt::threshold_off_permille(thr);
  bool rep = false;
  if (!contracting) {
    if (act >= on) {
      contracting = true;
      contraction_start = sample_n;
    }
  } else if (act < off) {
    contracting = false;
    if (sample_n - contraction_start >= MIN_REP_SAMPLES) rep = true;
  }

  // Minute boundary first: this sample belongs to the new minute.
  minute_tick();
  if (rep) {
    reps_since_boot++;
    acc.reps++;
  }
  acc.sum += act;
  acc.n++;
  if (act > acc.peak) acc.peak = act;
  if (act >= on) acc.active_n++;
  if (!sensor_ok) acc.ok_all = false;

  int64_t today = (int64_t)reps_since_boot + reps_offset;
  if (today < 0) today = 0;
  if (today > 65535) today = 65535;

  portENTER_CRITICAL(&mux);
  pub.adc = adc;
  pub.filtered = (uint16_t)(filtered + 0.5f);
  pub.activation = act;
  pub.contracting = contracting;
  pub.sensor_ok = sensor_ok;
  pub.calibrated = rest_cal && max_cal;
  pub.baseline_ready = baseline_ready;
  pub.calib_state = calib_state != kt::CALIB_IDLE ? calib_state : calib_req;
  pub.rest_raw = rest_raw;
  pub.max_raw = max_raw;
  pub.threshold_pct = thr;
  pub.reps_since_boot = reps_since_boot;
  pub.reps_today = (uint16_t)today;
  pub.minute_reps = acc.reps;
  pub.sim = sim_on;
  pub.samples = sample_n;
  pub.overruns = overruns;
  portEXIT_CRITICAL(&mux);
}

void sensor_task(void*) {
  TickType_t last = xTaskGetTickCount();
  const TickType_t period = pdMS_TO_TICKS(1000 / SAMPLE_HZ);
  uint32_t sim_n = 0;
  for (;;) {
    uint16_t adc = sim_on ? (uint16_t)(sim_sample(sim_n++) + 0.5f) : read_adc();
    process_sample(adc);
    // xTaskDelayUntil returns pdFALSE if we were late (e.g. flash write stall)
    if (xTaskDelayUntil(&last, period) == pdFALSE) overruns++;
  }
}

}  // namespace

void sensor_begin(uint16_t bid) {
  boot_id = bid;
  Settings s = settings_get();
  threshold_pct = s.threshold_pct;
  if (s.rest_cal) {
    rest_raw = s.rest_raw;
    rest_cal = true;
    baseline_ready = true;
  }
  if (s.max_cal) {
    max_raw = s.max_raw;
    max_cal = true;
  }
  analogReadResolution(12);
  analogSetPinAttenuation(SENSOR_PIN, ADC_11db);  // ~0..3.1 V full scale
  pinMode(SENSOR_PIN, INPUT);
  minute_start(0);
  seen_clock_gen = clock_generation();
  pub.threshold_pct = threshold_pct;
  pub.rest_raw = rest_raw;
  pub.max_raw = max_raw;
  pub.sensor_ok = true;
  // Core 1, above Arduino loop() (prio 1); NimBLE host runs on core 0.
  xTaskCreatePinnedToCore(sensor_task, "sensor", 4096, nullptr, 5, nullptr, 1);
}

SensorSnapshot sensor_snapshot() {
  portENTER_CRITICAL(&mux);
  SensorSnapshot s = pub;
  portEXIT_CRITICAL(&mux);
  return s;
}

bool sensor_start_calibration(uint8_t kind) {
  bool ok = false;
  portENTER_CRITICAL(&mux);
  if (calib_state == kt::CALIB_IDLE && calib_req == kt::CALIB_IDLE && !result_pending) {
    calib_req = kind;
    pub.calib_state = kind;
    ok = true;
  }
  portEXIT_CRITICAL(&mux);
  return ok;
}

bool sensor_take_calibration_result(CalibResult* out) {
  bool got = false;
  portENTER_CRITICAL(&mux);
  if (result_pending) {
    *out = result;
    result_pending = false;
    got = true;
  }
  portEXIT_CRITICAL(&mux);
  return got;
}

void sensor_set_threshold(uint8_t pct) { threshold_pct = pct; }
void sensor_set_sim(bool on) { sim_on = on; }
void sensor_set_reps_today_offset(int32_t offset) {
  portENTER_CRITICAL(&mux);
  reps_offset = offset;
  portEXIT_CRITICAL(&mux);
}
