import reports from '#lib/data/reports-4471.json';
import notes from '#lib/data/desk-notes.json';
import { tenantOf } from '#lib/kb/locales';
import { uniqueById, type Report } from '#lib/kb/causes';

export type ProblemKey = 'parser' | 'hint' | 'day-shift' | 'pre-booking';

export type ProblemSummary = {
  key: ProblemKey;
  title: string;
  count: number;
  channels: string[];
  tenants: string[];
  firstSeen: string;
  lastSeen: string;
  exampleIds: string[];
  description: string;
};

const PRE_BOOKING_IDS = new Set(['R-41236']);
const TIME_SHIFT_IDS = new Set(['R-41202', 'R-41209', 'R-41344', 'R-41620']);

export function getSplitProblems(ticket = 4471): ProblemSummary[] {
  const merged = uniqueById(reports as Report[]).filter((r) => r.mergedInto === ticket);

  const buckets: Record<ProblemKey, Report[]> = {
    parser: [],
    hint: [],
    'day-shift': [],
    'pre-booking': [],
  };

  for (const r of merged) {
    if (PRE_BOOKING_IDS.has(r.id)) {
      buckets['pre-booking'].push(r);
    } else if (TIME_SHIFT_IDS.has(r.id)) {
      buckets['day-shift'].push(r);
    } else {
      const t = tenantOf(r);
      if (r.channel === 'form' && t?.form === 'booking-v3') {
        buckets.hint.push(r);
      } else {
        buckets.parser.push(r);
      }
    }
  }

  const meta: Record<ProblemKey, { title: string; description: string }> = {
    parser: {
      title: 'Shared date parser reads month-first (MM/DD) in day-first locales',
      description: 'The shared calendar parser parses day-first dates as month-first, swapping month and day when day <= 12.',
    },
    hint: {
      title: 'booking-v3 form prints MM/DD/YYYY hint under day-first date field',
      description: 'Tenants running booking-v3 display an MM/DD/YYYY placeholder, prompting month-first input that conflicts with day-first parsing.',
    },
    'day-shift': {
      title: 'Timezone boundary shift moves bookings by one day',
      description: 'Cross-timezone meeting invites or boundary offsets shift calendar events by exactly one day.',
    },
    'pre-booking': {
      title: 'Invite delivered before booking timestamp',
      description: 'Invite delivery timestamp preceded booking creation time due to race condition or clock skew.',
    },
  };

  return (Object.keys(buckets) as ProblemKey[]).map((key) => {
    const list = buckets[key];
    const days = list.map((r) => r.receivedAt.slice(0, 10)).sort();
    const channels = [...new Set(list.map((r) => r.channel))].sort();
    const tenants = [...new Set(list.map((r) => r.tenant))].sort();
    return {
      key,
      title: meta[key].title,
      count: list.length,
      channels,
      tenants,
      firstSeen: days[0] ?? '',
      lastSeen: days[days.length - 1] ?? '',
      exampleIds: list.slice(0, 3).map((r) => r.id),
      description: meta[key].description,
    };
  });
}

