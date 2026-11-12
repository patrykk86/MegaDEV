// R5 / SCHED-4514: the same instant reads right in each viewer's own zone and date order.
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatLocal, isDayFirst, localeRegion } from '../app/time.js';

const opened = '2026-11-12T18:48:40.687Z';

test('a Berlin viewer sees CET time, day before month', () => {
  assert.equal(formatLocal(opened, { locale: 'de-DE', timeZone: 'Europe/Berlin' }), '12/11/2026 19:48');
});

test('an Auckland viewer sees her own zone and her own order', () => {
  assert.equal(formatLocal(opened, { locale: 'en-NZ', timeZone: 'Pacific/Auckland' }), '13/11/2026 07:48');
});

test('a US viewer keeps month first', () => {
  assert.equal(formatLocal(opened, { locale: 'en-US', timeZone: 'America/New_York' }), '11/12/2026 13:48');
});

test('an EU time zone forces day first even under a US locale', () => {
  assert.equal(formatLocal(opened, { locale: 'en-US', timeZone: 'Europe/Berlin' }), '12/11/2026 19:48');
});

test('an EU locale forces day first in a non-EU zone', () => {
  assert.equal(formatLocal(opened, { locale: 'pl-PL', timeZone: 'America/New_York' }), '12/11/2026 13:48');
});

test('midnight is 00:00, not 24:00', () => {
  assert.equal(
    formatLocal('2026-11-12T23:00:00.000Z', { locale: 'en-GB', timeZone: 'Europe/Berlin' }),
    '13/11/2026 00:00',
  );
});

test('a value that is not a date comes back unchanged', () => {
  assert.equal(formatLocal('not a date', { locale: 'en-GB' }), 'not a date');
});

test('the region is read off the tag, and Europe counts as day first', () => {
  assert.equal(localeRegion('en-GB'), 'GB');
  assert.equal(localeRegion('de'), '');
  assert.equal(isDayFirst('de-DE', 'Pacific/Auckland'), true);
  assert.equal(isDayFirst('en-NZ', 'Pacific/Auckland'), false);
  assert.equal(isDayFirst('en-US', 'Europe/Berlin'), true);
});
