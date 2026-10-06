// Usage and estimated cost, per day. The agent reports a cost for each reply (total_cost_usd);
// on a subscription that is an estimate of what the same work would cost at API prices, and
// the window says so. Days are kept for about two months, then dropped.
import { readJson, writeJson, localDay } from './store.mjs';

const KEEP_DAYS = 62;

export class UsageTracker {
  constructor(file, { now = () => new Date() } = {}) {
    this.file = file;
    this.now = now;
    this.days = null;
  }

  #load() {
    if (!this.days) {
      const raw = readJson(this.file, {});
      this.days = raw && typeof raw === 'object' ? raw : {};
    }
    return this.days;
  }

  #save() {
    const days = this.#load();
    const keys = Object.keys(days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete days[k];
    try { writeJson(this.file, days); } catch { /* the counts stay in memory until the next save */ }
  }

  /** One finished reply: its estimated cost and the number of turns it took. */
  record({ costUsd = 0, turns = 1 } = {}) {
    const cost = Number(costUsd);
    if (!Number.isFinite(cost) || cost < 0) return;
    const days = this.#load();
    const k = localDay(this.now());
    const d = days[k] || { costUsd: 0, replies: 0, runs: 0 };
    d.costUsd = Math.round((d.costUsd + cost) * 1e6) / 1e6;
    d.replies += 1;
    if (turns > 0) d.turns = (d.turns || 0) + turns;
    days[k] = d;
    this.#save();
  }

  /** Counted separately: a scheduled routine is not a reply in the chat, but it costs the same. */
  recordRun(costUsd = 0) {
    const days = this.#load();
    const k = localDay(this.now());
    const d = days[k] || { costUsd: 0, replies: 0, runs: 0 };
    const cost = Number(costUsd);
    if (Number.isFinite(cost) && cost > 0) d.costUsd = Math.round((d.costUsd + cost) * 1e6) / 1e6;
    d.runs = (d.runs || 0) + 1;
    days[k] = d;
    this.#save();
  }

  /** Totals for today and the last seven days, for the Overview card and the budget check. */
  summary(budgetUsd = 0) {
    const days = this.#load();
    const todayKey = localDay(this.now());
    const sum = (keys) => keys.reduce((acc, k) => {
      const d = days[k];
      if (!d) return acc;
      return { costUsd: acc.costUsd + (d.costUsd || 0), replies: acc.replies + (d.replies || 0), runs: acc.runs + (d.runs || 0) };
    }, { costUsd: 0, replies: 0, runs: 0 });
    const weekKeys = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(this.now());
      d.setDate(d.getDate() - i);
      weekKeys.push(localDay(d));
    }
    const round = (o) => ({ ...o, costUsd: Math.round(o.costUsd * 100) / 100 });
    const today = round(sum([todayKey]));
    return {
      today,
      week: round(sum(weekKeys)),
      budgetUsd,
      overBudget: budgetUsd > 0 && today.costUsd >= budgetUsd,
      alertedToday: !!(days[todayKey] && days[todayKey].alerted),
    };
  }

  /** Marks today's budget alert as sent, so it is told once a day, not on every reply. */
  markAlerted() {
    const days = this.#load();
    const k = localDay(this.now());
    days[k] = { costUsd: 0, replies: 0, runs: 0, ...(days[k] || {}), alerted: true };
    this.#save();
  }
}
