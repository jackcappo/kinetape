// GATT server per PROTOCOL.md (NimBLE-Arduino 1.4.x API).
//
//   Service 8f1e0000-...  LIVE (notify) / HISTORY (notify) / CONTROL (write w/ rsp) /
//   STATUS (read, notify)
//
// A tx task sends LIVE at 20 Hz while LIVE is subscribed, and STATUS on change
// (or on request) plus every 5 s while subscribed.
#pragma once
#include <stddef.h>
#include <stdint.h>

typedef void (*ControlHandler)(const uint8_t* data, size_t len);
typedef void (*StatusBuilder)(uint8_t* out32);

void ble_begin(ControlHandler on_control, StatusBuilder build_status);

bool ble_connected();
uint16_t ble_mtu();  // negotiated ATT MTU of the current connection (23 if unknown)
bool ble_history_subscribed();
const char* ble_name();

// Ask the tx task to notify STATUS as soon as possible (any task).
void ble_request_status_notify();

// Sends one HISTORY notification, waiting/retrying on host buffer congestion.
// Returns true once the packet is queued in the BLE stack.
bool ble_send_history(const uint8_t* data, size_t len);
