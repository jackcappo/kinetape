// Persistent ring log of 16-byte minute records on LittleFS.
//
// Layout: records are stored in wire format in SEG_COUNT segment files
// (/kt_sNNN.bin, SEG_RECORDS records = 2 KB each, i.e. < 1 flash block so an
// in-place overwrite only rewrites one block), plus /kt_meta.bin holding
// {magic, capacity, oldest_index, next_index, checksum}. Record with index i
// lives at slot i % CAPACITY. Indices are u32, monotonically increasing since
// the last CLEAR, never reused.
//
// Appends are posted from the sampling task through a queue (never blocks);
// a low-priority logger task does the flash I/O.
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

namespace minute_log {

constexpr uint32_t SEG_RECORDS = 128;
constexpr uint32_t SEG_COUNT = 128;
constexpr uint32_t CAPACITY = SEG_RECORDS * SEG_COUNT;  // 16384 records = 11.4 days
static_assert(CAPACITY >= 10080, "must hold >= 7 days of minute records");

bool begin();  // mounts LittleFS (formats on failure), loads meta, starts logger task

// Non-blocking; safe from any task. Returns false if the queue is full.
bool post(const kt::MinuteRecord& rec);

uint32_t oldest();
uint32_t next();
uint32_t dropped();  // records lost because the queue was full

// Reads up to max_n consecutive records starting at `index` (wire format,
// 16 B each, into out). Clamps to [oldest, next). Returns count read (0 if
// index >= next), or -1 on I/O error. *first_out = actual first index read.
int read_raw(uint32_t index, uint8_t* out, int max_n, uint32_t* first_out);

bool clear();  // wipes the log; indices restart at 0

// Sums reps for "today" bookkeeping. For every stored record:
//   boot_id == cur_boot: epoch = valid ? t : boot_epoch + t;  add reps to *before
//                        if epoch < midnight_utc
//   other boot, time_valid, t >= midnight_utc: add reps to *other_today
bool sum_reps_for_today(uint16_t cur_boot, int64_t boot_epoch, int64_t midnight_utc,
                        uint32_t* before, uint32_t* other_today);

}  // namespace minute_log
