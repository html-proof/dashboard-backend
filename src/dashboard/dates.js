import { localDate } from '../database/db.js';

// All ranges are inclusive calendar dates (YYYY-MM-DD) in the shop's own timezone.
export const PRESETS = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'last_90_days', 'this_week', 'this_month', 'last_month',
  'this_quarter', 'last_quarter', 'this_year', 'last_year', 'custom'];
export const GRANULARITIES = ['day', 'week', 'month', 'quarter', 'year'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const parse = (value) => new Date(`${value}T00:00:00Z`);
const format = (date) => date.toISOString().slice(0, 10);
export const addDays = (value, days) => { const d = parse(value); d.setUTCDate(d.getUTCDate() + days); return format(d); };
const addMonths = (value, months) => { const d = parse(value); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months); return format(d); };
const monthStart = (value) => `${value.slice(0, 7)}-01`;
const monthEnd = (value) => addDays(addMonths(monthStart(value), 1), -1);
const quarterStart = (value) => { const month = Math.floor((Number(value.slice(5, 7)) - 1) / 3) * 3 + 1; return `${value.slice(0, 4)}-${String(month).padStart(2, '0')}-01`; };
export const daysBetween = (start, end) => Math.round((parse(end) - parse(start)) / 86_400_000) + 1;

export class RangeError400 extends Error {}

function isValid(value) { return DATE.test(value || '') && format(parse(value)) === value; }

export function resolveRange(params, timeZone) {
  const today = localDate(new Date().toISOString(), timeZone);
  const start = params.get('start_date'); const end = params.get('end_date');
  let preset = params.get('preset') || (start || end ? 'custom' : 'last_30_days');
  if (!PRESETS.includes(preset)) throw new RangeError400(`Unknown preset. Use one of: ${PRESETS.join(', ')}`);

  let range;
  switch (preset) {
    case 'today': range = [today, today]; break;
    case 'yesterday': range = [addDays(today, -1), addDays(today, -1)]; break;
    case 'last_7_days': range = [addDays(today, -6), today]; break;
    case 'last_30_days': range = [addDays(today, -29), today]; break;
    case 'last_90_days': range = [addDays(today, -89), today]; break;
    case 'this_week': range = [addDays(today, -((parse(today).getUTCDay() + 6) % 7)), today]; break; // weeks start Monday
    case 'this_month': range = [monthStart(today), today]; break;
    case 'last_month': { const s = addMonths(monthStart(today), -1); range = [s, monthEnd(s)]; break; }
    case 'this_quarter': range = [quarterStart(today), today]; break;
    case 'last_quarter': { const s = addMonths(quarterStart(today), -3); range = [s, addDays(addMonths(s, 3), -1)]; break; }
    case 'this_year': range = [`${today.slice(0, 4)}-01-01`, today]; break;
    case 'last_year': { const y = Number(today.slice(0, 4)) - 1; range = [`${y}-01-01`, `${y}-12-31`]; break; }
    default:
      if (!isValid(start) || !isValid(end)) throw new RangeError400('Custom ranges need start_date and end_date as YYYY-MM-DD.');
      if (start > end) throw new RangeError400('start_date must be on or before end_date.');
      if (daysBetween(start, end) > 366 * 5) throw new RangeError400('Ranges are limited to 5 years.');
      range = [start, end];
  }
  // Today is still in progress; include_incomplete=0 stops a multi-day range at yesterday.
  if (params.get('include_incomplete') === '0' && range[1] === today && range[0] < today) range[1] = addDays(today, -1);
  const [startDate, endDate] = range;

  const days = daysBetween(startDate, endDate);
  let granularity = params.get('granularity');
  if (granularity && !GRANULARITIES.includes(granularity)) throw new RangeError400(`granularity must be one of: ${GRANULARITIES.join(', ')}`);
  granularity ||= days <= 62 ? 'day' : days <= 400 ? 'month' : 'quarter';

  const compare = params.get('compare');
  let comparison = null;
  if (compare === 'previous_period') comparison = { startDate: addDays(startDate, -days), endDate: addDays(startDate, -1), label: 'Previous period' };
  else if (compare === 'previous_year') comparison = { startDate: `${Number(startDate.slice(0, 4)) - 1}${startDate.slice(4)}`, endDate: `${Number(endDate.slice(0, 4)) - 1}${endDate.slice(4)}`.replace(/-02-29$/, '-02-28'), label: 'Same period last year' };
  else if (compare) throw new RangeError400('compare must be previous_period or previous_year.');

  return { preset, startDate, endDate, days, granularity, timeZone, today, comparison };
}

// JS twin of bucketSql, used to enumerate every bucket in a range.
export function bucketKey(day, granularity) {
  switch (granularity) {
    case 'week': return addDays(day, -((parse(day).getUTCDay() + 6) % 7));
    case 'month': return day.slice(0, 7);
    case 'quarter': return `${day.slice(0, 4)}-Q${Math.floor((Number(day.slice(5, 7)) + 2) / 3)}`;
    case 'year': return day.slice(0, 4);
    default: return day;
  }
}

// SQL expression that buckets a YYYY-MM-DD column into the requested granularity.
export function bucketSql(column, granularity) {
  switch (granularity) {
    case 'week': return `date(${column}, '-' || ((CAST(strftime('%w', ${column}) AS INTEGER) + 6) % 7) || ' days')`;
    case 'month': return `substr(${column}, 1, 7)`;
    case 'quarter': return `substr(${column}, 1, 4) || '-Q' || ((CAST(substr(${column}, 6, 2) AS INTEGER) + 2) / 3)`;
    case 'year': return `substr(${column}, 1, 4)`;
    default: return column;
  }
}
