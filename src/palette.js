










function hexToRgb(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * (((b - r) / d) + 2);
    else h = 60 * (((r - g) / d) + 4);
  }
  if (h < 0) h += 360;
  return { h, s: mx === 0 ? 0 : d / mx, v: mx };
}

function hsvToHex(h, s, v) {
  h = ((h % 360) + 360) % 360;
  s = Math.min(1, Math.max(0, s));
  v = Math.min(1, Math.max(0, v));
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to = n => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}


function normalizeSeed(raw) {
  const rgb = hexToRgb(raw);
  if (!rgb) return null;
  const to = n => n.toString(16).padStart(2, '0');
  return ('#' + to(rgb.r) + to(rgb.g) + to(rgb.b)).toUpperCase();
}






function paletteFromSeed(seedHex, dark) {
  const rgb = hexToRgb(seedHex);
  if (!rgb) return null;
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  const h = hsv.h;
  const s = hsv.s < 0.12 ? 0.35 : Math.min(hsv.s, 0.75);
  const c = (hue, sat, val) => hsvToHex(hue, sat, val);
  const m = {};
  if (dark) {
    m['primary'] = c(h, s * 0.55, 0.82);
    m['onPrimary'] = c(h, s * 0.85, 0.18);
    m['primaryContainer'] = c(h, s * 0.60, 0.30);
    m['onPrimaryContainer'] = c(h, s * 0.45, 0.94);
    m['secondary'] = c(h, s * 0.28, 0.80);
    m['onSecondary'] = c(h, s * 0.40, 0.18);
    m['secondaryContainer'] = c(h, s * 0.26, 0.30);
    m['onSecondaryContainer'] = c(h, s * 0.24, 0.93);
    m['tertiary'] = c(h + 60, s * 0.40, 0.80);
    m['onTertiary'] = c(h + 60, s * 0.45, 0.18);
    m['tertiaryContainer'] = c(h + 60, s * 0.36, 0.30);
    m['onTertiaryContainer'] = c(h + 60, s * 0.28, 0.93);
    m['background'] = c(h, 0.10, 0.09);
    m['surface'] = c(h, 0.10, 0.09);
    m['surfaceContainerLowest'] = c(h, 0.14, 0.06);
    m['surfaceContainer'] = c(h, 0.12, 0.13);
    m['surfaceContainerHigh'] = c(h, 0.11, 0.18);
    m['surfaceContainerHighest'] = c(h, 0.10, 0.23);
    m['onSurface'] = c(h, 0.05, 0.92);
    m['onSurfaceVariant'] = c(h, 0.12, 0.80);
    m['outline'] = c(h, 0.10, 0.60);
    m['outlineVariant'] = c(h, 0.10, 0.30);
    m['inverseSurface'] = c(h, 0.05, 0.92);
    m['inverseOnSurface'] = c(h, 0.08, 0.20);
  } else {
    m['primary'] = c(h, s * 0.80, 0.42);
    m['onPrimary'] = c(h, 0.06, 1.0);
    m['primaryContainer'] = c(h, s * 0.70, 0.92);
    m['onPrimaryContainer'] = c(h, s * 0.70, 0.14);
    m['secondary'] = c(h, s * 0.32, 0.40);
    m['onSecondary'] = c(h, 0.06, 1.0);
    m['secondaryContainer'] = c(h, s * 0.32, 0.91);
    m['onSecondaryContainer'] = c(h, s * 0.38, 0.14);
    m['tertiary'] = c(h + 60, s * 0.45, 0.40);
    m['onTertiary'] = c(h + 60, 0.06, 1.0);
    m['tertiaryContainer'] = c(h + 60, s * 0.45, 0.91);
    m['onTertiaryContainer'] = c(h + 60, s * 0.40, 0.16);
    m['background'] = c(h, 0.06, 0.99);
    m['surface'] = c(h, 0.06, 0.99);
    m['surfaceContainerLowest'] = c(h, 0.03, 1.0);
    m['surfaceContainer'] = c(h, 0.08, 0.95);
    m['surfaceContainerHigh'] = c(h, 0.09, 0.92);
    m['surfaceContainerHighest'] = c(h, 0.10, 0.89);
    m['onSurface'] = c(h, 0.12, 0.11);
    m['onSurfaceVariant'] = c(h, 0.14, 0.32);
    m['outline'] = c(h, 0.10, 0.50);
    m['outlineVariant'] = c(h, 0.12, 0.78);
    m['inverseSurface'] = c(h, 0.10, 0.20);
    m['inverseOnSurface'] = c(h, 0.05, 0.95);
  }
  return m;
}






function applyScheme(p, scheme, dark) {
  if (!p || scheme === 'standard') return p;
  const out = {};
  for (const k of Object.keys(p)) {
    const hex = p[k];
    const rgb = hexToRgb(hex);
    if (!rgb) { out[k] = hex; continue; }
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    let s = hsv.s, v = hsv.v;
    if (scheme === 'expressive') { s = Math.min(1, s * 1.3); }
    else if (scheme === 'vibrant') { s = Math.min(1, s * 1.6); v = Math.min(1, v * 1.08); }
    else if (scheme === 'muted') { s = s * 0.5; }
    else if (scheme === 'monochrome') { s = 0; }
    out[k] = hsvToHex(hsv.h, s, v);
  }
  return out;
}

module.exports = { paletteFromSeed, normalizeSeed, hexToRgb, rgbToHsv, hsvToHex, applyScheme };
