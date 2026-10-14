/** KineTape BLE Protocol v1 — constants. Source of truth: kinetape/PROTOCOL.md */

export const SERVICE_UUID = '8f1e0000-3c4a-4b7e-9a51-6b2f0c1d7e00';
export const LIVE_UUID = '8f1e0001-3c4a-4b7e-9a51-6b2f0c1d7e00';
export const HISTORY_UUID = '8f1e0002-3c4a-4b7e-9a51-6b2f0c1d7e00';
export const CONTROL_UUID = '8f1e0003-3c4a-4b7e-9a51-6b2f0c1d7e00';
export const STATUS_UUID = '8f1e0004-3c4a-4b7e-9a51-6b2f0c1d7e00';

export const DEVICE_NAME_PREFIX = 'KineTape';

export const PACKET_TYPE = {
  LIVE: 0x10,
  RECORDS: 0x20,
  END: 0x21,
  STATUS: 0x30,
} as const;

export const LIVE_LEN = 12;
export const RECORD_LEN = 16;
export const HISTORY_HEADER_LEN = 8;
export const END_LEN = 8;
export const STATUS_LEN = 32;
export const MAX_RECORDS_PER_PACKET = 10;
export const LIVE_HZ = 20;

export const OPCODE = {
  SET_TIME: 0x01,
  CALIBRATE_REST: 0x02,
  CALIBRATE_MAX: 0x03,
  SYNC_HISTORY: 0x04,
  CLEAR_HISTORY: 0x05,
  SET_THRESHOLD: 0x06,
  IDENTIFY: 0x07,
} as const;
export type Opcode = (typeof OPCODE)[keyof typeof OPCODE];

export const OPCODE_NAME: Record<number, string> = {
  0x00: 'none',
  0x01: 'SET_TIME',
  0x02: 'CALIBRATE_REST',
  0x03: 'CALIBRATE_MAX',
  0x04: 'SYNC_HISTORY',
  0x05: 'CLEAR_HISTORY',
  0x06: 'SET_THRESHOLD',
  0x07: 'IDENTIFY',
};

export const RESULT = {
  OK: 0,
  BAD_ARGS: 1,
  BUSY: 2,
  UNKNOWN_OPCODE: 3,
  FAILED: 4,
} as const;
export type ResultCode = (typeof RESULT)[keyof typeof RESULT];

export const RESULT_NAME: Record<number, string> = {
  0: 'ok',
  1: 'bad_args',
  2: 'busy',
  3: 'unknown_opcode',
  4: 'failed',
};

export const CALIB_STATE = {
  IDLE: 0,
  SAMPLING_REST: 1,
  SAMPLING_MAX: 2,
} as const;

/** LIVE flags */
export const LIVE_FLAG = { CONTRACTING: 1 << 0, CALIBRATED: 1 << 1, SENSOR_OK: 1 << 2 } as const;
/** Minute-record flags */
export const RECORD_FLAG = { TIME_VALID: 1 << 0, SENSOR_OK: 1 << 1 } as const;
/** STATUS flags */
export const STATUS_FLAG = { TIME_VALID: 1 << 0, CALIBRATED: 1 << 1, SENSOR_OK: 1 << 2 } as const;

export const THRESHOLD_MIN = 5;
export const THRESHOLD_MAX = 95;
export const DEFAULT_THRESHOLD_PCT = 30;
export const BATTERY_UNKNOWN = 255;
