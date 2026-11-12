// Local-time rendering for the board (plan R5, issue SCHED-4514).
// Times are shown in the viewer's own time zone; day comes before month for EU locales.

/** Regions whose written date order is day/month/year. */
const EU_REGIONS = new Set([
  'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU',
  'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
]);

/**
 * The region part of a BCP 47 tag: `en-GB` gives `GB`, `de` gives `''`.
 * @param {string} [locale]
 * @returns {string}
 */
export function localeRegion(locale) {
  if (!locale) return '';
  const parts = locale.split(/[-_]/);
  for (const part of parts.slice(1)) {
    if (/^[A-Za-z]{2}$/.test(part) && part.toUpperCase() !== 'LATN') return part.toUpperCase();
  }
  return '';
}

/**
 * True when the viewer reads dates day-first: an EU locale, or a time zone in Europe.
 * @param {string} [locale]
 * @param {string} [timeZone]
 * @returns {boolean}
 */
export function isDayFirst(locale, timeZone) {
  if (EU_REGIONS.has(localeRegion(locale))) return true;
  return typeof timeZone === 'string' && timeZone.startsWith('Europe/');
}

/**
 * One incident time in the viewer's zone: `dd/mm/yyyy hh:mm` for a day-first viewer, the locale's
 * own order otherwise. An unparseable value comes back as it arrived.
 * @param {string} iso
 * @param {{ locale?: string, timeZone?: string }} [options]
 * @returns {string}
 */
export function formatLocal(iso, options = {}) {
  const { locale, timeZone } = options;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);

  const parts = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(date);

  const value = (type) => parts.find((part) => part.type === type)?.value ?? '';
  const day = value('day');
  const month = value('month');
  const year = value('year');
  const time = `${value('hour')}:${value('minute')}`;

  if (isDayFirst(locale, timeZone)) return `${day}/${month}/${year} ${time}`;

  const order = parts
    .filter((part) => part.type === 'day' || part.type === 'month' || part.type === 'year')
    .map((part) => value(part.type));
  return `${order.join('/')} ${time}`;
}
