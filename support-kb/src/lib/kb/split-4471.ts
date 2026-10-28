import reports from '#lib/data/reports-4471.json';
import notes from '#lib/data/desk-notes.json';
import { tenantOf } from '#lib/kb/locales';
import { groupByCause, readAs, uniqueById, type CauseGroup, type Report } from '#lib/kb/causes';

export type DeskProblem = {
  cause: string;
  reports: number;
  tenants: number;
  firstSeen: string;
  lastSeen: string;
  ticketRef: string;
  oneDayMove: number;
};

export function getDeskProblems(ticket = 4471): { total: number; problems: DeskProblem[] } {
  const merged = uniqueById(reports as Report[]).filter((r) => r.mergedInto === ticket);
  const groups: CauseGroup[] = groupByCause(merged, tenantOf);

  const problems = groups.map((g) => ({
    cause: g.cause,
    reports: g.reports.length,
    tenants: g.tenants,
    firstSeen: g.firstSeen,
    lastSeen: g.lastSeen,
    ticketRef: g.cause === 'parser' ? '#1' : '#2',
    oneDayMove: readAs(g, notes.oneDayMove),
  }));

  return {
    total: merged.length,
    problems,
  };
}
