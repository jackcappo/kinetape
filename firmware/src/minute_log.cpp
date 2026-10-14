#include "minute_log.h"

#include <Arduino.h>
#include <LittleFS.h>

namespace minute_log {
namespace {

constexpr uint32_t META_MAGIC = 0x474C544B;  // "KTLG"
constexpr uint32_t META_VERSION = 1;
const char* META_PATH = "/kt_meta.bin";

SemaphoreHandle_t mtx;
QueueHandle_t q;
volatile uint32_t g_oldest = 0;
volatile uint32_t g_next = 0;
volatile uint32_t g_dropped = 0;
bool g_ok = false;

struct Lock {
  Lock() { xSemaphoreTake(mtx, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(mtx); }
};

void seg_path(uint32_t seg, char* buf, size_t n) { snprintf(buf, n, "/kt_s%03u.bin", (unsigned)seg); }

uint32_t meta_checksum(const uint8_t* b) {
  uint32_t h = 2166136261u;  // FNV-1a over the first 20 bytes
  for (int i = 0; i < 20; i++) h = (h ^ b[i]) * 16777619u;
  return h;
}

bool write_meta() {
  uint8_t b[24];
  kt::put_u32(b + 0, META_MAGIC);
  kt::put_u32(b + 4, META_VERSION);
  kt::put_u32(b + 8, CAPACITY);
  kt::put_u32(b + 12, g_oldest);
  kt::put_u32(b + 16, g_next);
  kt::put_u32(b + 20, meta_checksum(b));
  // LittleFS commits the new file contents atomically on close.
  File f = LittleFS.open(META_PATH, "w");
  if (!f) return false;
  size_t w = f.write(b, sizeof(b));
  f.close();
  return w == sizeof(b);
}

void remove_segments() {
  char p[24];
  for (uint32_t s = 0; s < SEG_COUNT; s++) {
    seg_path(s, p, sizeof(p));
    if (LittleFS.exists(p)) LittleFS.remove(p);
  }
}

bool load_meta() {
  File f = LittleFS.open(META_PATH, "r");
  if (!f) return false;
  uint8_t b[24];
  size_t r = f.read(b, sizeof(b));
  f.close();
  if (r != sizeof(b)) return false;
  if (kt::get_u32(b) != META_MAGIC || kt::get_u32(b + 4) != META_VERSION) return false;
  if (kt::get_u32(b + 8) != CAPACITY) return false;
  if (kt::get_u32(b + 20) != meta_checksum(b)) return false;
  uint32_t o = kt::get_u32(b + 12), n = kt::get_u32(b + 16);
  if (n < o || n - o > CAPACITY) return false;
  g_oldest = o;
  g_next = n;
  return true;
}

// Writes one 16 B record at the slot of `index`. Caller holds the lock.
bool write_slot(uint32_t index, const uint8_t* rec) {
  uint32_t slot = index % CAPACITY;
  uint32_t seg = slot / SEG_RECORDS;
  uint32_t off = (slot % SEG_RECORDS) * kt::RECORD_LEN;
  char p[24];
  seg_path(seg, p, sizeof(p));
  File f;
  if (LittleFS.exists(p)) {
    f = LittleFS.open(p, "r+");
  } else {
    f = LittleFS.open(p, "w");
  }
  if (!f) return false;
  size_t sz = f.size();
  if (sz < off) {  // only after an unexpected loss; keep offsets aligned
    f.seek(sz);
    static const uint8_t zeros[16] = {0};
    while (sz < off) {
      size_t chunk = off - sz < sizeof(zeros) ? off - sz : sizeof(zeros);
      f.write(zeros, chunk);
      sz += chunk;
    }
  }
  bool ok = f.seek(off) && f.write(rec, kt::RECORD_LEN) == kt::RECORD_LEN;
  f.close();
  return ok;
}

bool append_locked(const kt::MinuteRecord& rec) {
  uint8_t b[kt::RECORD_LEN];
  kt::encode_record(rec, b);
  if (!write_slot(g_next, b)) return false;
  uint32_t n = g_next + 1;
  uint32_t o = g_oldest;
  if (n - o > CAPACITY) o = n - CAPACITY;  // ring full: drop oldest
  g_oldest = o;
  g_next = n;
  return write_meta();
}

void logger_task(void*) {
  kt::MinuteRecord rec;
  for (;;) {
    if (xQueueReceive(q, &rec, portMAX_DELAY) == pdTRUE) {
      Lock l;
      if (!g_ok || !append_locked(rec)) {
        Serial.println("[log] append FAILED");
      }
    }
  }
}

}  // namespace

bool begin() {
  mtx = xSemaphoreCreateMutex();
  q = xQueueCreate(8, sizeof(kt::MinuteRecord));
  {
    Lock l;
    g_ok = LittleFS.begin(true);  // format on first use / corruption
    if (!g_ok) {
      Serial.println("[log] LittleFS mount failed");
    } else if (!load_meta()) {
      Serial.println("[log] no valid meta -> new empty log");
      remove_segments();
      g_oldest = g_next = 0;
      write_meta();
    }
  }
  xTaskCreatePinnedToCore(logger_task, "logger", 4096, nullptr, 1, nullptr, 0);
  return g_ok;
}

bool post(const kt::MinuteRecord& rec) {
  if (xQueueSend(q, &rec, 0) != pdTRUE) {
    g_dropped++;
    return false;
  }
  return true;
}

uint32_t oldest() { return g_oldest; }
uint32_t next() { return g_next; }
uint32_t dropped() { return g_dropped; }

int read_raw(uint32_t index, uint8_t* out, int max_n, uint32_t* first_out) {
  Lock l;
  if (!g_ok) return -1;
  if (index < g_oldest) index = g_oldest;
  if (first_out) *first_out = index;
  if (index >= g_next || max_n <= 0) return 0;
  uint32_t avail = g_next - index;
  uint32_t want = (uint32_t)max_n < avail ? (uint32_t)max_n : avail;
  uint32_t done = 0;
  char p[24];
  while (done < want) {
    uint32_t slot = (index + done) % CAPACITY;
    uint32_t seg = slot / SEG_RECORDS;
    uint32_t in_seg = slot % SEG_RECORDS;
    uint32_t n = SEG_RECORDS - in_seg;
    if (n > want - done) n = want - done;
    seg_path(seg, p, sizeof(p));
    File f = LittleFS.open(p, "r");
    if (!f) return -1;
    bool ok = f.seek(in_seg * kt::RECORD_LEN) &&
              f.read(out + done * kt::RECORD_LEN, n * kt::RECORD_LEN) == n * kt::RECORD_LEN;
    f.close();
    if (!ok) return -1;
    done += n;
  }
  return (int)done;
}

bool clear() {
  Lock l;
  if (!g_ok) return false;
  remove_segments();
  g_oldest = 0;
  g_next = 0;
  return write_meta();
}

bool sum_reps_for_today(uint16_t cur_boot, int64_t boot_epoch, int64_t midnight_utc,
                        uint32_t* before, uint32_t* other_today) {
  *before = 0;
  *other_today = 0;
  static uint8_t buf[SEG_RECORDS * kt::RECORD_LEN];  // only called from the control task
  uint32_t idx = oldest();
  for (;;) {
    uint32_t first;
    int n = read_raw(idx, buf, SEG_RECORDS, &first);
    if (n < 0) return false;
    if (n == 0) break;
    for (int i = 0; i < n; i++) {
      kt::MinuteRecord r;
      kt::decode_record(buf + i * kt::RECORD_LEN, &r);
      bool tv = r.flags & kt::REC_FLAG_TIME_VALID;
      if (r.boot_id == cur_boot) {
        int64_t e = tv ? (int64_t)r.t : boot_epoch + (int64_t)r.t;
        if (e < midnight_utc) *before += r.reps;
      } else if (tv && (int64_t)r.t >= midnight_utc) {
        *other_today += r.reps;
      }
    }
    idx = first + (uint32_t)n;
  }
  return true;
}

}  // namespace minute_log
