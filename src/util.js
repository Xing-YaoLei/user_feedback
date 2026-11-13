const pad2 = (n) => String(n).padStart(2, '0');

export function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

export function parseMs(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
}

export function todayKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local date key of an ISO timestamp, or null when it cannot be parsed. */
export function isoDateKey(value) {
  const ms = parseMs(value, NaN);
  return Number.isNaN(ms) ? null : todayKey(ms);
}

/** Next local occurrence of HH:MM strictly after `fromMs`. */
export function nextDailyAt(collectionTime, fromMs = Date.now()) {
  const [hour, minute] = String(collectionTime).split(':').map(Number);
  const d = new Date(fromMs);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Last millisecond of the local day containing `ms`. */
export function endOfDayMs(ms = Date.now()) {
  const d = new Date(ms);
  d.setHours(24, 0, 0, -1);
  return d.getTime();
}

/** Tomorrow's occurrence of HH:MM — used once today's collection is done. */
export function nextDailyTomorrow(collectionTime, ms = Date.now()) {
  return nextDailyAt(collectionTime, endOfDayMs(ms));
}

export function isValidClockTime(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export function randomId(prefix = '') {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}${out}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
