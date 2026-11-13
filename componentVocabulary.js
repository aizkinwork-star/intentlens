// componentVocabulary.js — the ElectroCom61 label set.
//
// These are the 61 class names the shipped local classifier was trained on
// (generated from datasets/processed/cnn_resnet18_v1/classifier.json). They are
// plain text, so they are committed: both the desktop and the PWA can give the
// vision provider the same vocabulary without loading the model.
//
// The names are raw dataset labels. Display them with `displayLabel()`.
//
// Dataset: ElectroCom61 v5 (Roboflow), CC BY 4.0. See docs/COMPONENT_RECOGNITION.md.

export const ELECTROCOM61_CLASSES = Object.freeze([
  '1-5-Volt-Battery',
  '3-3-Volt-Battery',
  '7-Segment-Display',
  '9-Volt-Battery',
  'Arduino-Mega',
  'Arduino-Nano',
  'Arduino-Uno',
  'BJT-Transistor',
  'Bluetooth-Module',
  'Breadboard',
  'Bridge-Rectifier',
  'Buck-Converter',
  'Buzzer',
  'Capacitor-10mf',
  'Capacitor-470mf',
  'DC-Motor',
  'Diode',
  'ESP32',
  'ESP32-CAM',
  'FT-232-USB-Serial-Module',
  'Film-Capacitor',
  'Fuse',
  'Fuse-Base',
  'GSM-Module',
  'Gas-Sensor',
  'Heat-Sink',
  'High-Voltage-Ceramic-Capacitor',
  'Humidity-Sensor',
  'IC-Base-14-Pin',
  'IC-Base-28-Pin',
  'IC-Chip',
  'IGBT',
  'IR-Sensor',
  'Inductor',
  'Keypad',
  'LCD-Display',
  'LDR-Sensor',
  'LED-Light',
  'Low-Voltage-Ceramic-Capacitor',
  'MLC-Capacitor',
  'MOSFET',
  'Motion-Sensor',
  'Motor-Driver',
  'NTC-Thermistor',
  'OLED-Display',
  'Pin-Header',
  'Push-Switch',
  'RFID-Scanner',
  'Raindrops-Module',
  'Relay-Module',
  'Resistor',
  'Rocker-Switch',
  'Servo-Motor',
  'Soil-Moisture-Sensor',
  'Sonar-Sensor',
  'TCRT5000',
  'Tact-Switch',
  'Taper-Potentiometer',
  'Trimmer-Potentiometer',
  'Water-Sensor',
  'Zener-Diode',
]);

/** Human-readable form of a raw dataset label ("FT-232-USB-Serial-Module" -> "FT-232 USB serial module"). */
export function displayLabel(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  return raw.replaceAll('-', ' ').replace(/\s+/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

/** True when `name` is one of the labels the local classifier can emit. */
export function isKnownComponentClass(name) {
  return ELECTROCOM61_CLASSES.includes(String(name || '').trim());
}
