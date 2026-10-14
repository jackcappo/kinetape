// CONTROL command processing (from BLE writes or the serial console), HISTORY
// streaming and STATUS assembly. Runs in its own task so BLE callbacks and the
// sampling task never block on flash or notifications.
#pragma once
#include <stddef.h>
#include <stdint.h>

void control_begin(uint16_t boot_id);

// Queue a raw CONTROL write (opcode + payload). Safe from any task / BLE callback.
void control_submit(const uint8_t* data, size_t len);

// Fills the 32-byte STATUS value.
void control_build_status(uint8_t* out32);

uint8_t control_last_cmd();
uint8_t control_last_result();
