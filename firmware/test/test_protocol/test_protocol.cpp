// Encoder/decoder self-check against ../../../protocol/test-vectors.json.
// Run on the board:  py -m platformio test -d firmware -e esp32dev
// (The hex strings below are copied verbatim from test-vectors.json.)
#include <string.h>
#include <unity.h>

#include "../../src/protocol.h"

#ifdef ARDUINO
#include <Arduino.h>
#endif

using namespace kt;

static size_t hex_to_bytes(const char* hex, uint8_t* out) {
  size_t n = strlen(hex) / 2;
  for (size_t i = 0; i < n; i++) {
    auto nib = [](char c) -> uint8_t {
      return (uint8_t)(c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10);
    };
    out[i] = (uint8_t)((nib(hex[2 * i]) << 4) | nib(hex[2 * i + 1]));
  }
  return n;
}

static void assert_bytes(const char* hex, const uint8_t* got, size_t got_len) {
  uint8_t want[256];
  size_t n = hex_to_bytes(hex, want);
  TEST_ASSERT_EQUAL_UINT32(n, got_len);
  TEST_ASSERT_EQUAL_HEX8_ARRAY(want, got, n);
}

static MinuteRecord rec_a() {
  MinuteRecord r = {};
  r.t = 1760000000;
  r.boot_id = 7;
  r.flags = 3;
  r.mean_activation_permille = 250;
  r.peak_activation_permille = 900;
  r.reps = 12;
  r.active_seconds = 18;
  return r;
}

static MinuteRecord rec_b() {
  MinuteRecord r = {};
  r.t = 3600;
  r.boot_id = 6;
  r.flags = 2;
  r.mean_activation_permille = 0;
  r.peak_activation_permille = 15;
  r.reps = 0;
  r.active_seconds = 0;
  return r;
}

void test_live() {
  LivePacket l = {};
  l.flags = 7;
  l.seq = 258;
  l.uptime_ms = 123456;
  l.raw = 2048;
  l.activation_permille = 750;
  uint8_t b[LIVE_LEN];
  size_t n = encode_live(l, b);
  assert_bytes("1007020140e201000008ee02", b, n);
}

void test_record() {
  uint8_t b[RECORD_LEN];
  assert_bytes("0078e76807000300fa0084030c001200", b, encode_record(rec_a(), b));
  assert_bytes("100e00000600020000000f0000000000", b, encode_record(rec_b(), b));
}

void test_record_roundtrip() {
  uint8_t b[RECORD_LEN];
  encode_record(rec_a(), b);
  MinuteRecord r;
  decode_record(b, &r);
  TEST_ASSERT_EQUAL_UINT32(1760000000u, r.t);
  TEST_ASSERT_EQUAL_UINT16(7, r.boot_id);
  TEST_ASSERT_EQUAL_UINT8(3, r.flags);
  TEST_ASSERT_EQUAL_UINT16(250, r.mean_activation_permille);
  TEST_ASSERT_EQUAL_UINT16(900, r.peak_activation_permille);
  TEST_ASSERT_EQUAL_UINT16(12, r.reps);
  TEST_ASSERT_EQUAL_UINT16(18, r.active_seconds);
}

void test_history_records() {
  const char* hex =
      "20020000290000000078e76807000300fa0084030c001200100e00000600020000000f0000000000";
  MinuteRecord recs[2] = {rec_a(), rec_b()};
  uint8_t b[HISTORY_MAX_LEN];
  assert_bytes(hex, b, encode_history_records(41, recs, 2, b));
  // raw path (records as stored in flash)
  uint8_t raw[2 * RECORD_LEN];
  encode_record(recs[0], raw);
  encode_record(recs[1], raw + RECORD_LEN);
  assert_bytes(hex, b, encode_history_records_raw(41, raw, 2, b));
  TEST_ASSERT_EQUAL_UINT32(0, encode_history_records(41, recs, 0, b));
  TEST_ASSERT_EQUAL_UINT32(0, encode_history_records(41, recs, 11, b));
}

void test_history_end() {
  uint8_t b[HISTORY_END_LEN];
  assert_bytes("210000005a000000", b, encode_history_end(0, 90, b));
}

void test_status() {
  StatusPacket s = {};
  s.fw_version = 1;
  s.flags = 7;
  s.calib_state = 0;
  s.epoch_now = 1760000123;
  s.uptime_s = 5400;
  s.boot_id = 7;
  s.rest_raw = 310;
  s.max_raw = 3150;
  s.threshold_pct = 30;
  s.battery_pct = 255;
  s.oldest_index = 0;
  s.next_index = 90;
  s.last_cmd = 4;
  s.last_result = 0;
  s.reps_today = 42;
  uint8_t b[STATUS_LEN];
  assert_bytes("300107007b78e76818150000070036014e0c1eff000000005a00000004002a00", b,
               encode_status(s, b));
}

void test_control_encode() {
  uint8_t b[8];
  assert_bytes("010078e76810ff", b, encode_set_time(1760000000, -240, b));
  assert_bytes("02", b, encode_simple_op(OP_CALIBRATE_REST, b));
  assert_bytes("03", b, encode_simple_op(OP_CALIBRATE_MAX, b));
  assert_bytes("0429000000", b, encode_sync_history(41, b));
  assert_bytes("05", b, encode_simple_op(OP_CLEAR_HISTORY, b));
  assert_bytes("0623", b, encode_set_threshold(35, b));
  assert_bytes("07", b, encode_simple_op(OP_IDENTIFY, b));
}

void test_control_parse() {
  uint8_t b[16];
  ControlCmd c;
  size_t n = hex_to_bytes("010078e76810ff", b);
  TEST_ASSERT_EQUAL(PARSE_OK, parse_control(b, n, &c));
  TEST_ASSERT_EQUAL_UINT8(OP_SET_TIME, c.opcode);
  TEST_ASSERT_EQUAL_UINT32(1760000000u, c.epoch_s);
  TEST_ASSERT_EQUAL_INT16(-240, c.tz_offset_min);

  n = hex_to_bytes("0429000000", b);
  TEST_ASSERT_EQUAL(PARSE_OK, parse_control(b, n, &c));
  TEST_ASSERT_EQUAL_UINT32(41, c.from_index);

  n = hex_to_bytes("0623", b);
  TEST_ASSERT_EQUAL(PARSE_OK, parse_control(b, n, &c));
  TEST_ASSERT_EQUAL_UINT8(35, c.threshold_pct);

  const char* simple[] = {"02", "03", "05", "07"};
  for (const char* h : simple) {
    n = hex_to_bytes(h, b);
    TEST_ASSERT_EQUAL(PARSE_OK, parse_control(b, n, &c));
  }

  // errors
  TEST_ASSERT_EQUAL(PARSE_BAD_ARGS, parse_control(b, 0, &c));
  n = hex_to_bytes("0604", b);  // threshold 4 < 5
  TEST_ASSERT_EQUAL(PARSE_BAD_ARGS, parse_control(b, n, &c));
  n = hex_to_bytes("0660", b);  // 96 > 95
  TEST_ASSERT_EQUAL(PARSE_BAD_ARGS, parse_control(b, n, &c));
  n = hex_to_bytes("04290000", b);  // short
  TEST_ASSERT_EQUAL(PARSE_BAD_ARGS, parse_control(b, n, &c));
  n = hex_to_bytes("0200", b);  // trailing byte
  TEST_ASSERT_EQUAL(PARSE_BAD_ARGS, parse_control(b, n, &c));
  n = hex_to_bytes("08", b);
  TEST_ASSERT_EQUAL(PARSE_UNKNOWN_OPCODE, parse_control(b, n, &c));
  TEST_ASSERT_EQUAL_UINT8(0x08, c.opcode);
}

void test_records_per_packet() {
  TEST_ASSERT_EQUAL_UINT8(0, records_per_packet(23));   // 20 B payload < 24
  TEST_ASSERT_EQUAL_UINT8(1, records_per_packet(27));   // 8+16 = 24 = 27-3
  TEST_ASSERT_EQUAL_UINT8(1, records_per_packet(42));
  TEST_ASSERT_EQUAL_UINT8(2, records_per_packet(43));
  TEST_ASSERT_EQUAL_UINT8(10, records_per_packet(171));  // 8+160 = 168 = 171-3
  TEST_ASSERT_EQUAL_UINT8(9, records_per_packet(170));
  TEST_ASSERT_EQUAL_UINT8(10, records_per_packet(185));
  TEST_ASSERT_EQUAL_UINT8(10, records_per_packet(247));
  TEST_ASSERT_EQUAL_UINT8(10, records_per_packet(517));
}

void test_activation() {
  TEST_ASSERT_EQUAL_UINT16(0, activation_permille(100, 310, 3150));
  TEST_ASSERT_EQUAL_UINT16(0, activation_permille(310, 310, 3150));
  TEST_ASSERT_EQUAL_UINT16(500, activation_permille(1730, 310, 3150));
  TEST_ASSERT_EQUAL_UINT16(1000, activation_permille(4000, 310, 3150));
  TEST_ASSERT_EQUAL_UINT16(0, activation_permille(2000, 3000, 3000));  // degenerate
  TEST_ASSERT_EQUAL_UINT16(300, threshold_on_permille(30));
  TEST_ASSERT_EQUAL_UINT16(180, threshold_off_permille(30));
}

static int run_all() {
  UNITY_BEGIN();
  RUN_TEST(test_live);
  RUN_TEST(test_record);
  RUN_TEST(test_record_roundtrip);
  RUN_TEST(test_history_records);
  RUN_TEST(test_history_end);
  RUN_TEST(test_status);
  RUN_TEST(test_control_encode);
  RUN_TEST(test_control_parse);
  RUN_TEST(test_records_per_packet);
  RUN_TEST(test_activation);
  return UNITY_END();
}

void setUp() {}
void tearDown() {}

#ifdef ARDUINO
void setup() {
  delay(2000);  // let the serial monitor attach
  run_all();
}
void loop() {}
#else
int main() { return run_all(); }
#endif
