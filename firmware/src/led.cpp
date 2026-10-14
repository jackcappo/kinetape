#include "led.h"

#include <Arduino.h>

#include "ble_service.h"

namespace {
volatile bool identify_req = false;

void led_task(void*) {
  uint32_t t = 0;  // ms
  const uint32_t step = 20;
  for (;;) {
    if (identify_req) {
      identify_req = false;
      for (int i = 0; i < 5; i++) {  // 5 x (100 ms on, 100 ms off)
        digitalWrite(LED_PIN, HIGH);
        vTaskDelay(pdMS_TO_TICKS(100));
        digitalWrite(LED_PIN, LOW);
        vTaskDelay(pdMS_TO_TICKS(100));
      }
      vTaskDelay(pdMS_TO_TICKS(300));
    }
    bool on;
    if (ble_connected()) {
      on = true;
    } else {
      on = (t % 2000) < 200;  // slow blink: 200 ms flash every 2 s while advertising
    }
    digitalWrite(LED_PIN, on ? HIGH : LOW);
    vTaskDelay(pdMS_TO_TICKS(step));
    t += step;
  }
}
}  // namespace

void led_begin() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  xTaskCreatePinnedToCore(led_task, "led", 2048, nullptr, 1, nullptr, 0);
}

void led_identify() { identify_req = true; }
