import { db } from '../database/db.js';
import { ValidationError } from './profit.js';

// Staff, shifts and the labour costing method. All values are entered by the business; nothing is estimated.
// A shift stores the rate and on-cost % in force when it was recorded, so later rate changes don't rewrite history.
export const LABOUR_METHODS = ['fixed_payroll', 'timesheets'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const round = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const need = (ok, message) => { if (!ok) throw new ValidationError(message); };
const validDate = (v) => DATE.test(v || '') && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const shiftCost = (s) => s.hours * s.rate * (1 + s.on_cost_pct / 100) + s.extra_costs;

export function labourMethod(shop) {
  return db.prepare("SELECT value FROM settings WHERE shop = ? AND key = 'labour_method'").get(shop)?.value || 'fixed_payroll';
}

export function setLabourMethod(shop, method) {
  need(LABOUR_METHODS.includes(method), `method must be one of: ${LABOUR_METHODS.join(', ')}`);
  db.prepare("INSERT INTO settings (shop, key, value) VALUES (?, 'labour_method', ?) ON CONFLICT(shop, key) DO UPDATE SET value = excluded.value").run(shop, method);
  return { method };
}

export function listStaff(shop) {
  return db.prepare('SELECT id, name, role, hourly_rate AS hourlyRate, on_cost_pct AS onCostPct, active, created_at AS createdAt FROM staff WHERE shop = ? ORDER BY active DESC, name').all(shop)
    .map((s) => ({ ...s, active: Boolean(s.active) }));
}

export function addStaff(shop, body) {
  const name = String(body?.name || '').trim().slice(0, 120);
  const rate = Number(body?.hourlyRate); const onCost = Number(body?.onCostPct ?? 0);
  need(name, 'Name is required.');
  need(Number.isFinite(rate) && rate >= 0 && rate < 10_000, 'hourlyRate must be a positive number.');
  need(Number.isFinite(onCost) && onCost >= 0 && onCost <= 200, 'onCostPct must be between 0 and 200.');
  const r = db.prepare('INSERT INTO staff (shop, name, role, hourly_rate, on_cost_pct, active, created_at) VALUES (?,?,?,?,?,1,?)')
    .run(shop, name, String(body?.role || '').trim().slice(0, 80) || null, rate, onCost, new Date().toISOString());
  return { id: Number(r.lastInsertRowid) };
}

// Staff with shifts are deactivated rather than deleted, so historical labour stays intact.
export function removeStaff(shop, id) {
  const hasShifts = db.prepare('SELECT 1 FROM shifts WHERE shop = ? AND staff_id = ? LIMIT 1').get(shop, id);
  const r = hasShifts
    ? db.prepare('UPDATE staff SET active = 0 WHERE shop = ? AND id = ?').run(shop, id)
    : db.prepare('DELETE FROM staff WHERE shop = ? AND id = ?').run(shop, id);
  return { removed: Number(r.changes) > 0, deactivated: Boolean(hasShifts) };
}

export function addShift(shop, body) {
  const staff = db.prepare('SELECT * FROM staff WHERE shop = ? AND id = ?').get(shop, Number(body?.staffId));
  need(staff, 'Choose a staff member.');
  need(validDate(body?.date), 'date must be YYYY-MM-DD.');
  const hours = Number(body?.hours); const extra = Number(body?.extraCosts || 0);
  need(Number.isFinite(hours) && hours > 0 && hours <= 24, 'hours must be between 0 and 24.');
  need(Number.isFinite(extra) && extra >= 0 && extra < 100_000, 'extraCosts must be a positive number.');
  const rate = body?.rate === undefined || body.rate === '' ? staff.hourly_rate : Number(body.rate);
  need(Number.isFinite(rate) && rate >= 0 && rate < 10_000, 'rate must be a positive number.');
  const r = db.prepare('INSERT INTO shifts (shop, staff_id, date, hours, rate, on_cost_pct, extra_costs, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(shop, staff.id, body.date, hours, rate, staff.on_cost_pct, extra, String(body?.note || '').slice(0, 200) || null, new Date().toISOString());
  return { id: Number(r.lastInsertRowid) };
}

export function deleteShift(shop, id) {
  return { removed: Number(db.prepare('DELETE FROM shifts WHERE shop = ? AND id = ?').run(shop, id).changes) > 0 };
}

// Daily shift cost, used by profit when the costing method is "timesheets".
export function shiftCostsByDay(shop, startDate, endDate) {
  const rows = db.prepare('SELECT date, hours, rate, on_cost_pct, extra_costs FROM shifts WHERE shop = ? AND date BETWEEN ? AND ?').all(shop, startDate, endDate);
  const byDay = new Map();
  for (const s of rows) byDay.set(s.date, (byDay.get(s.date) || 0) + shiftCost(s));
  return byDay;
}

export function hasShifts(shop) {
  return Boolean(db.prepare('SELECT 1 FROM shifts WHERE shop = ? LIMIT 1').get(shop));
}

export function staffOverview(shop, { startDate, endDate }) {
  const shifts = db.prepare(`SELECT sh.id, sh.date, sh.hours, sh.rate, sh.on_cost_pct, sh.extra_costs, sh.note, st.id AS staffId, st.name, st.role
    FROM shifts sh JOIN staff st ON st.id = sh.staff_id WHERE sh.shop = ? AND sh.date BETWEEN ? AND ? ORDER BY sh.date DESC, st.name`).all(shop, startDate, endDate);
  const method = labourMethod(shop);
  const hours = shifts.reduce((s, x) => s + x.hours, 0);
  const wages = shifts.reduce((s, x) => s + x.hours * x.rate, 0);
  const total = shifts.reduce((s, x) => s + shiftCost(x), 0);
  return {
    method,
    cards: {
      staffWithShifts: new Set(shifts.map((s) => s.staffId)).size,
      paidHours: round(hours),
      averageRate: hours > 0 ? round(wages / hours) : null,
      labourExpense: round(total)
    },
    shifts: shifts.map((s) => ({
      id: s.id, date: s.date, staff: s.name, role: s.role, hours: s.hours, rate: s.rate,
      onCosts: round(s.hours * s.rate * (s.on_cost_pct / 100)), extraCosts: round(s.extra_costs), total: round(shiftCost(s)), note: s.note,
      status: method === 'timesheets' ? 'Included in profit' : 'Recorded for review'
    })),
    staff: listStaff(shop)
  };
}
