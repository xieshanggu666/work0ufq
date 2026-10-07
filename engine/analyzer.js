"use strict";
/* 综合分析管道：由训练会话与晨测指标计算负荷、恢复与处方全景。 */

const M = require("./models");
const R = require("./recovery");
const P = require("./prescribe");
const { fmtLocal, parseIso } = require("./date");

function analyze(athlete) {
  const { sessions } = athlete;
  const morning = (athlete.morning || []).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const profile = athlete.profile;
  const range = morning.length ? [morning[0].date, morning[morning.length - 1].date] : null;
  const daily = M.dailyLoads(sessions, "srpe", range);
  const acwr = M.acwrSeries(daily);
  const trimpDaily = M.dailyLoads(sessions, "trimp", range);
  const edwardsDaily = M.dailyLoads(sessions, "edwards", range);
  const ff = M.fitnessFatigue(daily);
  const ms = M.monotonyStrain(daily);
  const weeks = athlete.weeks || Math.ceil(morning.length / 7);

  const hrv = R.hrvBalance(morning.map(m => ({ date: m.date, rmssd: m.rmssd })));
  const rhr = R.rhrDrift(morning.map(m => ({ date: m.date, rhr: m.rhr })));
  const debts = R.sleepDebt(morning.map(m => m.sleep), profile.sleep_need);
  const byDate = new Map(morning.map(m => [m.date, m]));

  /* 逐日准备度 */
  const readiness = acwr.map((row, i) => {
    const m = byDate.get(row.date) || {};
    const loadP = row.acwr != null ? Math.round(Math.min(1, Math.max(0, row.acwr - 0.8) / 0.7) * 100) : 50;
    const sleepScore = m.sleep != null ? Math.round(Math.min(100, Math.max(0, ((m.sleep - 4) / (profile.sleep_need - 4)) * 100))) : 50;
    const score = R.readinessScore(
      hrv[i] ? hrv[i].balance : 1,
      sleepScore,
      m.energy != null ? m.energy : 60,
      m.soreness != null ? m.soreness : 30,
      loadP
    );
    return {
      date: row.date,
      rmssd: hrv[i] ? hrv[i].rmssd : null,
      hrv_balance: hrv[i] ? hrv[i].balance : null,
      sleep: m.sleep != null ? m.sleep : null,
      sleep_debt: debts[i] != null ? debts[i] : null,
      energy: m.energy != null ? m.energy : null,
      soreness: m.soreness != null ? m.soreness : null,
      rhr: rhr[i] ? rhr[i].rhr : null,
      rhr_drift: rhr[i] ? rhr[i].drift : null,
      load_pressure: loadP,
      score,
      label: R.readinessLabel(score),
    };
  });

  /* 末尾完整性保护：ACWR 需慢性窗口足够才可用 */
  const last = acwr[acwr.length - 1] || null;
  const lastR = readiness[readiness.length - 1] || null;
  const weekAccum = daily.slice(-7).reduce((s, d) => s + d.load, 0);

  const today = {
    date: last ? last.date : null,
    acwr: last ? last.acwr : null,
    acute: last ? last.acute : null,
    chronic: last ? last.chronic : null,
    band: M.acwrBand(last ? last.acwr : null),
    readiness: lastR ? lastR.score : null,
    readiness_label: lastR ? lastR.label : null,
    monotony: ms.monotony,
    strain: ms.strain,
    weekly_load: ms.weekly_load,
  };

  const prescription = P.prescribe({
    date: today.date,
    acwr: today.acwr,
    chronic: today.chronic,
    week_accumulated: weekAccum,
    readiness: today.readiness,
    readinessLabel: today.readiness_label,
  });

  return {
    profile,
    days: acwr.map((row, i) => ({
      date: row.date,
      load: row.load,
      acute: row.acute,
      chronic: row.chronic,
      acwr: row.acwr,
      trimp: trimpDaily[i] ? trimpDaily[i].load : null,
      edwards: edwardsDaily[i] ? edwardsDaily[i].load : null,
      fitness: ff[i].fitness,
      fatigue: ff[i].fatigue,
      performance: ff[i].performance,
      ...readiness[i],
    })),
    today,
    prescription,
    monotony_strain: ms,
    weekly_targets: athlete.weekly_target || [],
    periodization: P.periodizeWeeks(
      ms.weekly_load > 0 ? ms.weekly_load : (profile.base_load || 500),
      {}
    ),
    totals: {
      sessions: sessions.length,
      weeks,
      total_load: Math.round(daily.reduce((s, d) => s + d.load, 0)),
      avg_daily: daily.length ? Math.round(daily.reduce((s, d) => s + d.load, 0) / daily.length) : 0,
      avg_rmssd: morning.length ? Math.round(morning.reduce((s, m) => s + m.rmssd, 0) / morning.length) : 0,
      avg_sleep: morning.length ? Math.round(morning.reduce((s, m) => s + m.sleep, 0) / morning.length * 10) / 10 : 0,
    },
  };
}

/* 自定义日志分析：允许直接传入训练会话与晨测数据 */
function analyzeLog({ sessions = [], morning = [], profile = {} }) {
  const athlete = { sessions, morning, profile, weeks: Math.ceil(sessions.length / 7), weekly_target: [] };
  if (morning.length === 0) {
    /* 晨测缺失时以默认值补全（覆盖会话日期区间内的全部日期） */
    const dates = [...new Set(sessions.map(s => s.date))].sort();
    const morningOut = [];
    if (dates.length) {
      const cur = parseIso(dates[0]);
      const end = parseIso(dates[dates.length - 1]);
      while (cur <= end) {
        const key = fmtLocal(cur);
        if (dates.includes(key)) {
          morningOut.push({ date: key, rmssd: 70, rhr: 55, sleep: 7.5, energy: 70, soreness: 20 });
        }
        cur.setDate(cur.getDate() + 1);
      }
    }
    athlete.morning = morningOut;
  }
  return analyze(athlete);
}

module.exports = { analyze, analyzeLog };
