// KineTape BLE protocol v1 - pure packing/unpacking (see ../../PROTOCOL.md).
//
// NO Arduino / ESP-IDF dependencies: this header compiles on any C++11 host and
// is used both by the firmware and by test/test_protocol.
//
// Every multi-byte field is written byte-by-byte, little-endian. We never memcpy
// structs onto the wire, so compiler padding / host endianness cannot leak out.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace kt {

// ---------------------------------------------------------------- constants
constexpr uint8_t FW_VERSION = 1;

constexpr uint8_t PKT_LIVE = 0x10;
constexpr uint8_t PKT_HISTORY_RECORDS = 0x20;
constexpr uint8_t PKT_HISTORY_END = 0x21;
constexpr uint8_t PKT_STATUS = 0x30;

constexpr uint8_t OP_NONE = 0x00;
constexpr uint8_t OP_SET_TIME = 0x01;
constexpr uint8_t OP_CALIBRATE_REST = 0x02;
constexpr uint8_t OP_CALIBRATE_MAX = 0x03;
constexpr uint8_t OP_SYNC_HISTORY = 0x04;
constexpr uint8_t OP_CLEAR_HISTORY = 0x05;
constexpr uint8_t OP_SET_THRESHOLD = 0x06;
constexpr uint8_t OP_IDENTIFY = 0x07;

constexpr uint8_t RESULT_OK = 0;
constexpr uint8_t RESULT_BAD_ARGS = 1;
constexpr uint8_t RESULT_BUSY = 2;
constexpr uint8_t RESULT_UNKNOWN_OPCODE = 3;
constexpr uint8_t RESULT_FAILED = 4;

constexpr uint8_t CALIB_IDLE = 0;
constexpr uint8_t CALIB_REST = 1;
constexpr uint8_t CALIB_MAX = 2;

// LIVE.flags / STATUS.flags bits
constexpr uint8_t LIVE_FLAG_CONTRACTING = 0x01;
constexpr uint8_t LIVE_FLAG_CALIBRATED = 0x02;
constexpr uint8_t LIVE_FLAG_SENSOR_OK = 0x04;
constexpr uint8_t STATUS_FLAG_TIME_VALID = 0x01;
constexpr uint8_t STATUS_FLAG_CALIBRATED = 0x02;
constexpr uint8_t STATUS_FLAG_SENSOR_OK = 0x04;
// minute record flags
constexpr uint8_t REC_FLAG_TIME_VALID = 0x01;
constexpr uint8_t REC_FLAG_SENSOR_OK = 0x02;

constexpr uint8_t BATTERY_UNKNOWN = 255;

// Wire sizes, spelled out field-by-field so a typo in a table shows up here.
constexpr size_t LIVE_LEN = 1 + 1 + 2 + 4 + 2 + 2;                          // 12
constexpr size_t RECORD_LEN = 4 + 2 + 1 + 1 + 2 + 2 + 2 + 2;                // 16
constexpr size_t HISTORY_HDR_LEN = 1 + 1 + 2 + 4;                           // 8
constexpr size_t HISTORY_END_LEN = 1 + 1 + 2 + 4;                           // 8
constexpr size_t STATUS_LEN = 1 + 1 + 1 + 1 + 4 + 4 + 2 + 2 + 2 + 1 + 1 + 4 + 4 + 1 + 1 + 2;  // 32
constexpr size_t HISTORY_MAX_RECORDS = 10;
constexpr size_t HISTORY_MAX_LEN = HISTORY_HDR_LEN + RECORD_LEN * HISTORY_MAX_RECORDS;  // 168
constexpr size_t ATT_NOTIFY_OVERHEAD = 3;  // opcode + handle

static_assert(sizeof(uint8_t) == 1 && sizeof(uint16_t) == 2 && sizeof(uint32_t) == 4,
              "fixed-width ints required");
static_assert(LIVE_LEN == 12, "LIVE must be 12 bytes");
static_assert(RECORD_LEN == 16, "minute record must be 16 bytes");
static_assert(HISTORY_HDR_LEN == 8, "RECORDS header must be 8 bytes");
static_assert(HISTORY_END_LEN == 8, "END must be 8 bytes");
static_assert(STATUS_LEN == 32, "STATUS must be 32 bytes");
static_assert(HISTORY_MAX_LEN == 168, "10 records + header");

// ---------------------------------------------------------------- LE helpers
inline void put_u8(uint8_t* p, uint8_t v) { p[0] = v; }
inline void put_u16(uint8_t* p, uint16_t v) {
  p[0] = (uint8_t)(v & 0xFF);
  p[1] = (uint8_t)((v >> 8) & 0xFF);
}
inline void put_i16(uint8_t* p, int16_t v) { put_u16(p, (uint16_t)v); }
inline void put_u32(uint8_t* p, uint32_t v) {
  p[0] = (uint8_t)(v & 0xFF);
  p[1] = (uint8_t)((v >> 8) & 0xFF);
  p[2] = (uint8_t)((v >> 16) & 0xFF);
  p[3] = (uint8_t)((v >> 24) & 0xFF);
}
inline uint16_t get_u16(const uint8_t* p) { return (uint16_t)(p[0] | ((uint16_t)p[1] << 8)); }
inline int16_t get_i16(const uint8_t* p) { return (int16_t)get_u16(p); }
inline uint32_t get_u32(const uint8_t* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

// ---------------------------------------------------------------- LIVE
struct LivePacket {
  uint8_t flags;
  uint16_t seq;
  uint32_t uptime_ms;
  uint16_t raw;                  // filtered ADC 0..4095
  uint16_t activation_permille;  // 0..1000
};

// Writes exactly LIVE_LEN bytes. Returns LIVE_LEN.
inline size_t encode_live(const LivePacket& l, uint8_t* out) {
  put_u8(out + 0, PKT_LIVE);
  put_u8(out + 1, l.flags);
  put_u16(out + 2, l.seq);
  put_u32(out + 4, l.uptime_ms);
  put_u16(out + 8, l.raw);
  put_u16(out + 10, l.activation_permille);
  return LIVE_LEN;
}

// ---------------------------------------------------------------- minute record
struct MinuteRecord {
  uint32_t t;
  uint16_t boot_id;
  uint8_t flags;
  // reserved byte is always written as 0
  uint16_t mean_activation_permille;
  uint16_t peak_activation_permille;
  uint16_t reps;
  uint16_t active_seconds;
};

inline size_t encode_record(const MinuteRecord& r, uint8_t* out) {
  put_u32(out + 0, r.t);
  put_u16(out + 4, r.boot_id);
  put_u8(out + 6, r.flags);
  put_u8(out + 7, 0);  // reserved
  put_u16(out + 8, r.mean_activation_permille);
  put_u16(out + 10, r.peak_activation_permille);
  put_u16(out + 12, r.reps);
  put_u16(out + 14, r.active_seconds);
  return RECORD_LEN;
}

inline void decode_record(const uint8_t* in, MinuteRecord* r) {
  r->t = get_u32(in + 0);
  r->boot_id = get_u16(in + 4);
  r->flags = in[6];
  r->mean_activation_permille = get_u16(in + 8);
  r->peak_activation_permille = get_u16(in + 10);
  r->reps = get_u16(in + 12);
  r->active_seconds = get_u16(in + 14);
}

// ---------------------------------------------------------------- HISTORY
// Records per RECORDS packet for a negotiated ATT MTU: 1..10 with 8+16n <= MTU-3.
// Returns 0 if not even one record fits (e.g. default MTU 23).
inline uint8_t records_per_packet(uint16_t att_mtu) {
  if (att_mtu < ATT_NOTIFY_OVERHEAD + HISTORY_HDR_LEN + RECORD_LEN) return 0;
  size_t n = (att_mtu - ATT_NOTIFY_OVERHEAD - HISTORY_HDR_LEN) / RECORD_LEN;
  if (n > HISTORY_MAX_RECORDS) n = HISTORY_MAX_RECORDS;
  return (uint8_t)n;
}

// Encodes a RECORDS packet. `n` must be 1..10 and out must hold 8+16n bytes.
// Returns the packet length, or 0 on invalid n.
inline size_t encode_history_records(uint32_t first_index, const MinuteRecord* recs, uint8_t n,
                                     uint8_t* out) {
  if (n < 1 || n > HISTORY_MAX_RECORDS) return 0;
  put_u8(out + 0, PKT_HISTORY_RECORDS);
  put_u8(out + 1, n);
  put_u16(out + 2, 0);  // reserved
  put_u32(out + 4, first_index);
  for (uint8_t i = 0; i < n; i++) encode_record(recs[i], out + HISTORY_HDR_LEN + RECORD_LEN * i);
  return HISTORY_HDR_LEN + RECORD_LEN * (size_t)n;
}

// Same, but from records already in wire format (16 B each), as stored in flash.
inline size_t encode_history_records_raw(uint32_t first_index, const uint8_t* raw_recs, uint8_t n,
                                         uint8_t* out) {
  if (n < 1 || n > HISTORY_MAX_RECORDS) return 0;
  put_u8(out + 0, PKT_HISTORY_RECORDS);
  put_u8(out + 1, n);
  put_u16(out + 2, 0);
  put_u32(out + 4, first_index);
  for (size_t i = 0; i < RECORD_LEN * (size_t)n; i++) out[HISTORY_HDR_LEN + i] = raw_recs[i];
  return HISTORY_HDR_LEN + RECORD_LEN * (size_t)n;
}

inline size_t encode_history_end(uint8_t status, uint32_t next_index, uint8_t* out) {
  put_u8(out + 0, PKT_HISTORY_END);
  put_u8(out + 1, status);
  put_u16(out + 2, 0);  // reserved
  put_u32(out + 4, next_index);
  return HISTORY_END_LEN;
}

// ---------------------------------------------------------------- STATUS
struct StatusPacket {
  uint8_t fw_version;
  uint8_t flags;
  uint8_t calib_state;
  uint32_t epoch_now;
  uint32_t uptime_s;
  uint16_t boot_id;
  uint16_t rest_raw;
  uint16_t max_raw;
  uint8_t threshold_pct;
  uint8_t battery_pct;
  uint32_t oldest_index;
  uint32_t next_index;
  uint8_t last_cmd;
  uint8_t last_result;
  uint16_t reps_today;
};

inline size_t encode_status(const StatusPacket& s, uint8_t* out) {
  put_u8(out + 0, PKT_STATUS);
  put_u8(out + 1, s.fw_version);
  put_u8(out + 2, s.flags);
  put_u8(out + 3, s.calib_state);
  put_u32(out + 4, s.epoch_now);
  put_u32(out + 8, s.uptime_s);
  put_u16(out + 12, s.boot_id);
  put_u16(out + 14, s.rest_raw);
  put_u16(out + 16, s.max_raw);
  put_u8(out + 18, s.threshold_pct);
  put_u8(out + 19, s.battery_pct);
  put_u32(out + 20, s.oldest_index);
  put_u32(out + 24, s.next_index);
  put_u8(out + 28, s.last_cmd);
  put_u8(out + 29, s.last_result);
  put_u16(out + 30, s.reps_today);
  return STATUS_LEN;
}

// ---------------------------------------------------------------- CONTROL
struct ControlCmd {
  uint8_t opcode;
  uint32_t epoch_s;       // SET_TIME
  int16_t tz_offset_min;  // SET_TIME
  uint32_t from_index;    // SYNC_HISTORY
  uint8_t threshold_pct;  // SET_THRESHOLD
};

enum ParseStatus : uint8_t {
  PARSE_OK = RESULT_OK,
  PARSE_BAD_ARGS = RESULT_BAD_ARGS,
  PARSE_UNKNOWN_OPCODE = RESULT_UNKNOWN_OPCODE,
};

// Total write length (opcode included) for each opcode, 0 if unknown.
inline size_t control_len(uint8_t opcode) {
  switch (opcode) {
    case OP_SET_TIME: return 1 + 4 + 2;
    case OP_CALIBRATE_REST: return 1;
    case OP_CALIBRATE_MAX: return 1;
    case OP_SYNC_HISTORY: return 1 + 4;
    case OP_CLEAR_HISTORY: return 1;
    case OP_SET_THRESHOLD: return 1 + 1;
    case OP_IDENTIFY: return 1;
    default: return 0;
  }
}

// Strict parser: the write length must match the opcode exactly; SET_THRESHOLD
// must be 5..95. An empty write is BAD_ARGS with opcode 0.
inline ParseStatus parse_control(const uint8_t* in, size_t len, ControlCmd* c) {
  c->opcode = OP_NONE;
  c->epoch_s = 0;
  c->tz_offset_min = 0;
  c->from_index = 0;
  c->threshold_pct = 0;
  if (len == 0) return PARSE_BAD_ARGS;
  c->opcode = in[0];
  size_t want = control_len(in[0]);
  if (want == 0) return PARSE_UNKNOWN_OPCODE;
  if (len != want) return PARSE_BAD_ARGS;
  switch (c->opcode) {
    case OP_SET_TIME:
      c->epoch_s = get_u32(in + 1);
      c->tz_offset_min = get_i16(in + 5);
      if (c->epoch_s == 0) return PARSE_BAD_ARGS;
      if (c->tz_offset_min < -14 * 60 || c->tz_offset_min > 14 * 60) return PARSE_BAD_ARGS;
      break;
    case OP_SYNC_HISTORY:
      c->from_index = get_u32(in + 1);
      break;
    case OP_SET_THRESHOLD:
      c->threshold_pct = in[1];
      if (c->threshold_pct < 5 || c->threshold_pct > 95) return PARSE_BAD_ARGS;
      break;
    default:
      break;
  }
  return PARSE_OK;
}

// Encoders for CONTROL (used by the unit test and the serial console).
inline size_t encode_set_time(uint32_t epoch_s, int16_t tz_offset_min, uint8_t* out) {
  put_u8(out, OP_SET_TIME);
  put_u32(out + 1, epoch_s);
  put_i16(out + 5, tz_offset_min);
  return 7;
}
inline size_t encode_sync_history(uint32_t from_index, uint8_t* out) {
  put_u8(out, OP_SYNC_HISTORY);
  put_u32(out + 1, from_index);
  return 5;
}
inline size_t encode_set_threshold(uint8_t pct, uint8_t* out) {
  put_u8(out, OP_SET_THRESHOLD);
  put_u8(out + 1, pct);
  return 2;
}
inline size_t encode_simple_op(uint8_t opcode, uint8_t* out) {
  put_u8(out, opcode);
  return 1;
}

// ---------------------------------------------------------------- signal math
// activation_permille = clamp((filtered - rest) / (max - rest), 0, 1) * 1000, rounded.
inline uint16_t activation_permille(float filtered, uint16_t rest_raw, uint16_t max_raw) {
  if (max_raw <= rest_raw) return 0;
  float a = (filtered - (float)rest_raw) / (float)(max_raw - rest_raw);
  if (a <= 0.0f) return 0;
  if (a >= 1.0f) return 1000;
  return (uint16_t)(a * 1000.0f + 0.5f);
}

// Hysteresis thresholds in permille.
inline uint16_t threshold_on_permille(uint8_t threshold_pct) { return (uint16_t)threshold_pct * 10; }
inline uint16_t threshold_off_permille(uint8_t threshold_pct) { return (uint16_t)threshold_pct * 6; }

}  // namespace kt
