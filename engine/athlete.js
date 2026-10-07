"use strict";
/* 合成运动员训练历史生成器：
   按四周递进-减载周期生成会话日志与每日晨测指标，
   同种子完全可复现；生理指标随负荷与疲劳动态演化。 */

const { mulberry32, range, int } = require("./rng");
const { fmtLocal, parseIso } = require("./date");

const SPORT_POOL = {
  run: { label: "跑步", min: 25, max: 100 },
  ride: { label: "骑行", min: 40, max: 130 },
  swim: { label: "游泳", min: 25, max: 65 },
  strength: { label: "力量", min: 35, max: 75 },
};

/* 一周训练分布：[周一..周日] 各日负荷占比；周日休息 */
const WEEK_SHAPE = [0.16, 0.13, 0.09, 0.16, 0.10, 0.36, 0];

function daysFrom(iso, n) {
  const out = [];
  const d = parseIso(iso);
  for (let i = 0; i < n; i++) {
    out.push(fmtLocal(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function generateAthlete(opts = {}) {
  const seed = opts.seed != null ? opts.seed : 20261007;
  const weeks = opts.weeks != null ? opts.weeks : 8;
  const sex = opts.sex || "m";
  const restHr = opts.rest_hr != null ? opts.rest_hr : 54;
  const maxHr = opts.max_hr != null ? opts.max_hr : 196;
  const sleepNeed = opts.sleep_need != null ? opts.sleep_need : 7.5;
  const hrvBase = opts.hrv_base != null ? opts.hrv_base : 72;
  const baseLoad = opts.base_load != null ? opts.base_load : (sex === "f" ? 430 : 500);
  const start = opts.start || "2026-03-02";

  const rng = mulberry32(seed);
  const dates = daysFrom(start, weeks * 7);

  /* 每周目标负荷：四周块 [1, 1.08, 1.16, 0.6×1.16]，块间基准小幅上移 */
  const weeklyTarget = [];
  for (let w = 0; w < weeks; w++) {
    const block = Math.floor(w / 4);
    const phase = w % 4;
    const base = baseLoad * (1 + 0.04 * block);
    const f = [1, 1.08, 1.16, 0.696][phase];
    weeklyTarget.push(Math.round(base * f));
  }

  const sessions = [];
  const morning = [];
  let fatigue = 0; // 0-1 疲劳因子
  let drift = 0;   // 静息心率漂移
  let prevSore = 0;

  for (let w = 0; w < weeks; w++) {
    const target = weeklyTarget[w];
    for (let day = 0; day < 7; day++) {
      const date = dates[w * 7 + day];
      const frac = WEEK_SHAPE[day];
      const dayLoad = target * frac;

      if (dayLoad > 0) {
        const nSessions = frac >= 0.3 ? 2 : (rng() < 0.12 ? 2 : 1);
        const sport = pickSport(day, rng);
        const sportA = SPORT_POOL[sport];
        let remaining = dayLoad;
        for (let k = 0; k < nSessions; k++) {
          const last = k === nSessions - 1;
          const minutes = Math.round(range(rng, sportA.min, sportA.max));
          const rpeCap = remaining / minutes;
          const rpe = clamp(roundHalf(range(rng, Math.max(1.5, rpeCap * 0.8), Math.min(9.5, rpeCap * 1.15))), 1, 10);
          const load = rpe * minutes;
          remaining = Math.max(0, remaining - load);
          const zoneFrac = zoneOf(rpe);
          const avgHr = Math.round(restHr + zoneFrac * (maxHr - restHr) + range(rng, -4, 4) + drift * 3);
          sessions.push({
            date,
            sport,
            sport_label: SPORT_POOL[sport].label,
            minutes,
            rpe,
            avg_hr: Math.max(restHr + 2, Math.min(maxHr - 2, avgHr)),
            rest_hr: restHr,
            max_hr: maxHr,
            sex,
          });
          if (last) break;
        }
      }

      /* 疲劳因子：近 3 日平均负荷 / 周目标，均值回归到 0.5 */
      const recent3 = recentLoad(sessions, date, 3);
      const wTarget = target || 1;
      fatigue = 0.82 * fatigue + 0.18 * clamp(recent3 / wTarget, 0, 2);

      /* 静息心率漂移与疲劳正相关 */
      drift = 0.85 * drift + 0.15 * (fatigue * 9) + range(rng, -0.8, 0.8);

      /* 晨测指标 */
      const rmssd = Math.max(22, Math.round(hrvBase * (1 - 0.45 * fatigue) + range(rng, -4, 4)));
      const rhr = Math.round(restHr + drift + range(rng, -1, 1));
      const dow = new Date(date + "T00:00:00").getDay();
      const sleep = round1(clamp(sleepNeed + (dow === 0 || dow === 6 ? 0.6 : 0) + range(rng, -0.7, 0.7), 5, 10.5));
      const energy = Math.round(clamp(100 - fatigue * 72 + range(rng, -6, 6), 5, 100));
      const soreness = Math.round(clamp(prevSore * 0.6 + (fatigue > 0.55 ? 18 : 6) + (dayHasStrength(sessions, date) ? 14 : 0) + range(rng, -4, 4), 0, 100));
      prevSore = soreness;

      morning.push({ date, rmssd, rhr, sleep, energy, soreness });
    }
  }

  return {
    seed,
    profile: { sex, rest_hr: restHr, max_hr: maxHr, sleep_need: sleepNeed, hrv_base: hrvBase, base_load: baseLoad },
    weeks,
    sessions,
    morning,
    weekly_target: weeklyTarget,
  };
}

function recentLoad(sessions, date, n) {
  const cutoff = new Date(date + "T00:00:00");
  cutoff.setDate(cutoff.getDate() - (n - 1));
  const c = cutoff.toISOString().slice(0, 10);
  let sum = 0;
  for (const s of sessions) {
    if (s.date >= c && s.date <= date) sum += s.rpe * s.minutes;
  }
  return sum;
}

function dayHasStrength(sessions, date) {
  return sessions.some(s => s.date === date && s.sport === "strength");
}

function pickSport(day, rng) {
  const dow = day; // 0 周一
  const table = ["run", "ride", "swim", "run", "strength", "run", "rest"];
  return table[dow] === "rest" ? "run" : table[dow];
}

function zoneOf(rpe) {
  if (rpe < 3) return 0.55;
  if (rpe < 4.5) return 0.65;
  if (rpe < 6) return 0.75;
  if (rpe < 8) return 0.85;
  return 0.95;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function roundHalf(x) {
  return Math.round(x * 2) / 2;
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

module.exports = { generateAthlete, WEEK_SHAPE, SPORT_POOL };
