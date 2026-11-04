// phoneBoard.js — the demo phone motherboard: each part and where it sits (0..1 coordinates).
// x,y = centre of the part, w,h = its size, conf = how sure the mock model is.
export const COMPONENTS = [
  { id: 'U1', label: 'Main processor (SoC)', kind: 'chip', x: .42, y: .42, w: .16, h: .26, conf: .92, re: /soc|processor|cpu|main chip|brain/, desc: 'The big square chip near the centre is the main processor (SoC). It runs the whole phone.' },
  { id: 'U2', label: 'RAM (LPDDR)', kind: 'chip', x: .60, y: .40, w: .09, h: .14, conf: .88, re: /\bram\b|memory|lpddr/, desc: 'The chip just right of the processor is the RAM, the short-term memory.' },
  { id: 'U3', label: 'Storage chip (UFS/NAND)', kind: 'chip', x: .60, y: .62, w: .10, h: .12, conf: .80, re: /storage|nand|ufs|emmc/, desc: 'The chip below the RAM looks like the storage chip, where apps and photos are kept.' },
  { id: 'U4', label: 'Power management IC', kind: 'chip', x: .27, y: .55, w: .07, h: .09, conf: .62, re: /pmic|power/, desc: 'Probably the power management chip, left of the processor. Check it against the board markings.' },
  { id: 'U5', label: 'Charging IC', kind: 'chip', x: .20, y: .72, w: .06, h: .07, conf: .58, re: /charger|charging ic|charge ic/, desc: 'Possibly the charging chip near the lower-left. Small parts are hard to tell apart.' },
  { id: 'U6', label: 'Audio codec', kind: 'chip', x: .36, y: .75, w: .05, h: .06, conf: .55, re: /audio|codec|sound/, desc: 'Maybe the audio codec, low and left of centre. Not sure, so zoom in and verify.' },
  { id: 'U7', label: 'Modem / RF shield', kind: 'shield', x: .78, y: .60, w: .12, h: .16, conf: .78, re: /modem|\brf\b|antenna|shield/, desc: 'The metal shield on the right covers the modem and radio parts.' },
  { id: 'J1', label: 'Battery connector', kind: 'conn', x: .12, y: .30, w: .07, h: .05, conf: .85, re: /battery/, desc: 'The small gold connector at the upper left is the battery connector.' },
  { id: 'J2', label: 'Display connector', kind: 'conn', x: .88, y: .20, w: .08, h: .05, conf: .80, re: /display|screen|lcd/, desc: 'The connector at the top right is the display connector.' },
  { id: 'J3', label: 'Camera connector', kind: 'conn', x: .74, y: .15, w: .07, h: .05, conf: .80, re: /camera/, desc: 'The small connector near the top is for the camera module.' },
  { id: 'J4', label: 'USB-C port', kind: 'port', x: .50, y: .90, w: .14, h: .07, conf: .90, re: /usb|type-c|port/, desc: 'The metal port on the bottom edge is the USB-C charging port.' },
  { id: 'S1', label: 'SIM tray', kind: 'tray', x: .06, y: .72, w: .06, h: .12, conf: .75, re: /sim/, desc: 'The slot on the left edge is the SIM tray.' },
];
