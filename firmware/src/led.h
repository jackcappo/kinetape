// Status LED on GPIO2: slow blink = advertising, solid = connected,
// 5 fast blinks = IDENTIFY.
#pragma once

constexpr int LED_PIN = 2;

void led_begin();
void led_identify();
