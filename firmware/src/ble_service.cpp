#include "ble_service.h"

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <esp_system.h>

#include "clock.h"
#include "protocol.h"
#include "sensor.h"

namespace {

const char* SVC_UUID = "8f1e0000-3c4a-4b7e-9a51-6b2f0c1d7e00";
const char* LIVE_UUID = "8f1e0001-3c4a-4b7e-9a51-6b2f0c1d7e00";
const char* HISTORY_UUID = "8f1e0002-3c4a-4b7e-9a51-6b2f0c1d7e00";
const char* CONTROL_UUID = "8f1e0003-3c4a-4b7e-9a51-6b2f0c1d7e00";
const char* STATUS_UUID = "8f1e0004-3c4a-4b7e-9a51-6b2f0c1d7e00";

constexpr uint16_t REQUESTED_MTU = 247;
constexpr uint32_t LIVE_PERIOD_MS = 50;      // 20 Hz
constexpr uint32_t STATUS_CHECK_MS = 100;
constexpr uint32_t STATUS_PERIODIC_MS = 5000;

char g_name[20];
ControlHandler g_on_control = nullptr;
StatusBuilder g_build_status = nullptr;

NimBLEServer* server = nullptr;
NimBLECharacteristic* live_chr = nullptr;
NimBLECharacteristic* hist_chr = nullptr;
NimBLECharacteristic* ctrl_chr = nullptr;
NimBLECharacteristic* status_chr = nullptr;

volatile bool g_connected = false;
volatile uint16_t g_conn = 0xFFFF;
volatile uint16_t g_mtu = 23;
volatile bool live_sub = false;
volatile bool hist_sub = false;
volatile bool status_sub = false;
volatile bool status_req = false;

SemaphoreHandle_t status_mtx;

void refresh_status_value(uint8_t* out) {
  g_build_status(out);
  xSemaphoreTake(status_mtx, portMAX_DELAY);
  status_chr->setValue(out, kt::STATUS_LEN);
  xSemaphoreGive(status_mtx);
}

class ServerCb : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, ble_gap_conn_desc* desc) override {
    g_conn = desc->conn_handle;
    g_mtu = 23;
    g_connected = true;
    // Ask for a large ATT MTU (the central may also initiate; either is fine).
    ble_gattc_exchange_mtu(desc->conn_handle, nullptr, nullptr);
    // 15-30 ms interval, no latency, 4 s supervision timeout.
    s->updateConnParams(desc->conn_handle, 12, 24, 0, 400);
    Serial.println("[ble] connected");
  }
  void onDisconnect(NimBLEServer*, ble_gap_conn_desc*) override {
    g_connected = false;
    g_conn = 0xFFFF;
    g_mtu = 23;
    live_sub = hist_sub = status_sub = false;
    Serial.println("[ble] disconnected -> advertising");
    NimBLEDevice::startAdvertising();
  }
  void onMTUChange(uint16_t mtu, ble_gap_conn_desc*) override {
    g_mtu = mtu;
    Serial.printf("[ble] MTU %u\n", mtu);
  }
};

class SubCb : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic* c, ble_gap_conn_desc*, uint16_t sub) override {
    bool on = (sub & 0x0001) != 0;  // notifications bit
    if (c == live_chr) live_sub = on;
    else if (c == hist_chr) hist_sub = on;
    else if (c == status_chr) {
      status_sub = on;
      if (on) status_req = true;
    }
  }
  void onRead(NimBLECharacteristic* c, ble_gap_conn_desc*) override {
    if (c == status_chr) {
      uint8_t b[kt::STATUS_LEN];
      refresh_status_value(b);
    }
  }
};

class ControlCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, ble_gap_conn_desc*) override {
    NimBLEAttValue v = c->getValue();
    if (g_on_control) g_on_control(v.data(), v.length());
  }
};

ServerCb server_cb;
SubCb sub_cb;
ControlCb ctrl_cb;

void tx_task(void*) {
  TickType_t last = xTaskGetTickCount();
  uint16_t seq = 0;
  uint32_t tick = 0;
  uint8_t last_sent[kt::STATUS_LEN] = {0};
  bool have_last = false;
  uint32_t last_status_ms = 0;
  for (;;) {
    vTaskDelayUntil(&last, pdMS_TO_TICKS(LIVE_PERIOD_MS));
    tick++;
    if (g_connected && live_sub) {
      SensorSnapshot s = sensor_snapshot();
      kt::LivePacket lp;
      lp.flags = (s.contracting ? kt::LIVE_FLAG_CONTRACTING : 0) |
                 (s.calibrated ? kt::LIVE_FLAG_CALIBRATED : 0) |
                 (s.sensor_ok ? kt::LIVE_FLAG_SENSOR_OK : 0);
      lp.seq = seq++;
      lp.uptime_ms = clock_uptime_ms();
      lp.raw = s.filtered;
      lp.activation_permille = s.activation;
      uint8_t b[kt::LIVE_LEN];
      kt::encode_live(lp, b);
      live_chr->notify(b, sizeof(b));
    }
    if (tick % (STATUS_CHECK_MS / LIVE_PERIOD_MS) == 0) {
      uint8_t b[kt::STATUS_LEN];
      refresh_status_value(b);
      uint32_t now = millis();
      // "changed" ignores epoch_now (4..7) and uptime_s (8..11), which tick every second
      bool changed = !have_last || memcmp(b, last_sent, 4) != 0 ||
                     memcmp(b + 12, last_sent + 12, kt::STATUS_LEN - 12) != 0;
      bool due = now - last_status_ms >= STATUS_PERIODIC_MS;
      bool req = status_req;
      if (g_connected && status_sub && (changed || due || req)) {
        status_req = false;
        xSemaphoreTake(status_mtx, portMAX_DELAY);
        status_chr->notify(b, sizeof(b));
        xSemaphoreGive(status_mtx);
        memcpy(last_sent, b, sizeof(b));
        have_last = true;
        last_status_ms = now;
      } else if (!g_connected) {
        have_last = false;
        status_req = false;
      }
    }
  }
}

}  // namespace

void ble_begin(ControlHandler on_control, StatusBuilder build_status) {
  g_on_control = on_control;
  g_build_status = build_status;
  status_mtx = xSemaphoreCreateMutex();

  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_BT);
  snprintf(g_name, sizeof(g_name), "KineTape-%02X%02X", mac[4], mac[5]);

  NimBLEDevice::init(g_name);
  NimBLEDevice::setMTU(REQUESTED_MTU);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  server = NimBLEDevice::createServer();
  server->setCallbacks(&server_cb, false);
  server->advertiseOnDisconnect(false);  // we restart it explicitly in onDisconnect

  NimBLEService* svc = server->createService(SVC_UUID);
  live_chr = svc->createCharacteristic(LIVE_UUID, NIMBLE_PROPERTY::NOTIFY);
  hist_chr = svc->createCharacteristic(HISTORY_UUID, NIMBLE_PROPERTY::NOTIFY);
  ctrl_chr = svc->createCharacteristic(CONTROL_UUID, NIMBLE_PROPERTY::WRITE);
  status_chr = svc->createCharacteristic(STATUS_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  live_chr->setCallbacks(&sub_cb);
  hist_chr->setCallbacks(&sub_cb);
  status_chr->setCallbacks(&sub_cb);
  ctrl_chr->setCallbacks(&ctrl_cb);

  uint8_t b[kt::STATUS_LEN];
  g_build_status(b);
  status_chr->setValue(b, sizeof(b));
  svc->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(SVC_UUID);
  adv->setScanResponse(true);  // 128-bit UUID in adv data, name in scan response
  adv->setName(g_name);
  adv->start();
  Serial.printf("[ble] advertising as %s\n", g_name);

  xTaskCreatePinnedToCore(tx_task, "ble_tx", 4096, nullptr, 3, nullptr, 0);
}

bool ble_connected() { return g_connected; }
uint16_t ble_mtu() {
  if (!g_connected) return 23;
  uint16_t m = server->getPeerMTU(g_conn);
  return m ? m : g_mtu;
}
bool ble_history_subscribed() { return g_connected && hist_sub; }
const char* ble_name() { return g_name; }
void ble_request_status_notify() { status_req = true; }

bool ble_send_history(const uint8_t* data, size_t len) {
  // NimBLE-Arduino 1.4's notify() swallows the host return code, so call the
  // host directly to detect buffer exhaustion (BLE_HS_ENOMEM) and retry.
  for (int attempt = 0; attempt < 100; attempt++) {  // up to ~2 s
    if (!g_connected || !hist_sub) return false;
    os_mbuf* om = ble_hs_mbuf_from_flat(data, len);
    if (om != nullptr) {
      int rc = ble_gattc_notify_custom(g_conn, hist_chr->getHandle(), om);  // consumes om
      if (rc == 0) return true;
    }
    vTaskDelay(pdMS_TO_TICKS(20));
  }
  return false;
}
