"use strict";
/* 综合分析管道：由训练会话与晨测指标计算负荷、恢复与处方全景。
   可选传入协作计划（plan）与截止日期（asOf）：
   - 时间轴扩展到计划结束日，asOf 之后为计划投影日（is_projected）
   - 投影 ACWR / 体能-疲劳用于高风险预判
   - 当日处方附加计划课程与执行风险（高风险自动降级为恢复课） */

const M = require("./models");
const R = require("./recovery");
const P = require("./prescribe");
const PL = require("./plan");
const { fmtLocal, parseIso } = require("./date");

function addDays(iso, n) {
  const d = parseIso(iso);
  d.setDate(d.getDate() + n);
  return fmtLocal(d);
}

function analyze(athlete, opts = {}) {
  const { sessions } = athlete;
  const morning = (athlete.morning || []).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const profile = athlete.profile;
  const plan = opts.plan || null;

  /* 截止日期（"今天"）：默认取最后一天晨测/会话；有计划而无历史时取计划开始前一天 */
  let asOf = opts.asOf || null;
  if (!asOf) {
    if (morning.length) asOf = morning[morning.length - 1].date;
    else if (sessions.length) asOf = sessions.map(s => s.date).sort().pop();
    else if (plan) asOf = addDays(plan.start_date, -1);
  }

  /* 计算区间：晨测区间 ∪ 计划区间 */
  let range = morning.length ? [morning[0].date, morning[morning.length - 1].date] : null;
  if (plan) {
    range = range
      ? [range[0] < plan.start_date ? range[0] : plan.start_date, range[1] > plan.end_date ? range[1] : plan.end_date]
      : [plan.start_date, plan.end_date];
  }

  const plannedMap = plan ? new Map(plan.schedule.map(d => [d.date, d])) : null;
  const actualDaily = M.dailyLoads(sessions, "srpe", range);

  /* 拼接实际与投影负荷：计划期内 asOf 之后用计划目标负荷 */
  const mergedDaily = actualDaily.map(d => {
    const planned = plannedMap ? plannedMap.get(d.date) : null;
    if (plan && d.date > asOf && planned) {
      return { date: d.date, load: planned.target_load, is_projected: true, planned_load: planned.target_load };
    }
    return { date: d.date, load: d.load, is_projected: false, planned_load: planned ? planned.target_load : null };
  });

  const loadRows = mergedDaily.map(d => ({ date: d.date, load: d.load }));
  const acwr = M.acwrSeries(loadRows);
  const trimpDaily = M.dailyLoads(sessions, "trimp", range);
  const edwardsDaily = M.dailyLoads(sessions, "edwards", range);
  const ff = M.fitnessFatigue(loadRows);
  const ms = M.monotonyStrain(loadRows.filter(d => !d.is_projected).map(d => ({ date: d.date, load: d.load })));
  const weeks = athlete.weeks || Math.ceil(morning.length / 7);

  /* 恢复指标按晨测日期建索引，投影日无晨测 → 留空 */
  const hrvRows = R.hrvBalance(morning.map(m => ({ date: m.date, rmssd: m.rmssd })));
  const rhrRows = R.rhrDrift(morning.map(m => ({ date: m.date, rhr: m.rhr })));
  const debtVals = R.sleepDebt(morning.map(m => m.sleep), profile.sleep_need);
  const hrvByDate = new Map(hrvRows.map(r => [r.date, r]));
  const rhrByDate = new Map(rhrRows.map(r => [r.date, r]));
  const debtByDate = new Map(morning.map((m, i) => [m.date, debtVals[i]]));
  const byDate = new Map(morning.map(m => [m.date, m]));

  /* 逐日准备度：投影日不产生评分（未来无晨测），仅保留负荷压力 */
  const readiness = acwr.map(row => {
    const base = {
      date: row.date,
      rmssd: null, hrv_balance: null, sleep: null, sleep_debt: null,
      energy: null, soreness: null, rhr: null, rhr_drift: null,
    };
    const loadP = row.acwr != null ? Math.round(Math.min(1, Math.max(0, row.acwr - 0.8) / 0.7) * 100) : 50;
    base.load_pressure = loadP;
    if (row.date > asOf) {
      return { ...base, score: null, label: null };
    }
    const m = byDate.get(row.date) || {};
    const hv = hrvByDate.get(row.date);
    const rv = rhrByDate.get(row.date);
    const sleepScore = m.sleep != null ? Math.round(Math.min(100, Math.max(0, ((m.sleep - 4) / (profile.sleep_need - 4)) * 100))) : 50;
    const score = R.readinessScore(
      hv ? hv.balance : 1,
      sleepScore,
      m.energy != null ? m.energy : 60,
      m.soreness != null ? m.soreness : 30,
      loadP
    );
    return {
      ...base,
      rmssd: hv ? hv.rmssd : null,
      hrv_balance: hv ? hv.balance : null,
      sleep: m.sleep != null ? m.sleep : null,
      sleep_debt: debtByDate.has(row.date) ? debtByDate.get(row.date) : null,
      energy: m.energy != null ? m.energy : null,
      soreness: m.soreness != null ? m.soreness : null,
      rhr: rv ? rv.rhr : null,
      rhr_drift: rv ? rv.drift : null,
      score,
      label: R.readinessLabel(score),
    };
  });

  /* “今日”取截止日所在行；周累计取截止日向前 7 日的实际负荷 */
  const upto = acwr.filter(r => r.date <= asOf);
  const last = upto[upto.length - 1] || null;
  const lastR = readiness.filter(r => r.date <= asOf).pop() || null;
  const weekStart = last ? addDays(last.date, -6) : null;
  const weekAccum = mergedDaily.filter(d => !d.is_projected && weekStart && d.date >= weekStart && d.date <= (last ? last.date : weekStart)).reduce((s, d) => s + d.load, 0);

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

  /* 当日计划课程与执行风险回写到处方 */
  let projection = null;
  let execution = null;
  if (plan) {
    const todayItem = plannedMap.get(today.date);
    if (todayItem) {
      execution = PL.executionRisk(plan, {
        date: today.date,
        acwr: today.acwr,
        readiness: today.readiness,
        week_accumulated: weekAccum,
      });
      prescription.planned = {
        date: todayItem.date,
        is_rest_day: todayItem.is_rest,
        planned_load: todayItem.target_load,
        sessions: todayItem.sessions,
      };
      prescription.plan_status = execution.level === "high" ? "adjusted" : execution.level === "warn" ? "caution" : "planned";
      prescription.execution_risk = execution;
      if (todayItem.is_rest) {
        prescription.plan_status = "rest_day";
        prescription.suggested_load = 0;
        prescription.suggested_range = [0, 0];
        prescription.note = "今日为计划休息日，以恢复为主";
      } else if (execution.level === "high") {
        const reduced = Math.round(todayItem.target_load * 0.4);
        prescription.suggested_load = reduced;
        prescription.suggested_range = [Math.round(reduced * 0.8), Math.round(reduced * 1.2)];
        prescription.note = "执行风险高（" + execution.factors.filter(f => f.level === "high").map(f => f.message).join("；") + "），计划课降级为 Z1 恢复课";
      } else {
        prescription.suggested_load = todayItem.target_load;
        prescription.suggested_range = [Math.round(todayItem.target_load * 0.9), Math.round(todayItem.target_load * 1.1)];
        if (execution.level === "warn") {
          prescription.plan_status = "caution";
          prescription.note = "按计划执行，注意：" + execution.factors.map(f => f.message).join("；");
        } else {
          prescription.note = "状态适宜，按今日计划课程执行";
        }
      }
    }

    /* 投影 ACWR 峰值（计划区间内 asOf 之后） */
    let peak = null;
    let peakDate = null;
    for (const r of acwr) {
      if (r.date > asOf && plannedMap.has(r.date) && r.acwr != null && (peak === null || r.acwr > peak)) {
        peak = r.acwr;
        peakDate = r.date;
      }
    }
    projection = {
      as_of: asOf,
      peak_acwr: peak,
      peak_date: peakDate,
      planned_total: plan.schedule.reduce((s, d) => s + d.target_load, 0),
      planned_remaining: plan.schedule.filter(d => d.date > asOf).reduce((s, d) => s + d.target_load, 0),
    };
  }

  const actualRows = mergedDaily.filter(d => !d.is_projected);
  const result = {
    profile,
    as_of: asOf,
    days: acwr.map((row, i) => ({
      date: row.date,
      load: row.load,
      is_projected: mergedDaily[i].is_projected,
      planned_load: mergedDaily[i].planned_load,
      acute: row.acute,
      chronic: row.chronic,
      acwr: row.acwr,
      trimp: mergedDaily[i].is_projected ? null : (trimpDaily[i] ? trimpDaily[i].load : null),
      edwards: mergedDaily[i].is_projected ? null : (edwardsDaily[i] ? edwardsDaily[i].load : null),
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
      total_load: Math.round(actualRows.reduce((s, d) => s + d.load, 0)),
      avg_daily: actualRows.length ? Math.round(actualRows.reduce((s, d) => s + d.load, 0) / actualRows.length) : 0,
      avg_rmssd: morning.length ? Math.round(morning.reduce((s, m) => s + m.rmssd, 0) / morning.length) : 0,
      avg_sleep: morning.length ? Math.round(morning.reduce((s, m) => s + m.sleep, 0) / morning.length * 10) / 10 : 0,
    },
  };
  if (plan) {
    result.plan = plan;
    result.projection = projection;
  }
  return result;
}

/* 自定义日志分析：允许直接传入训练会话与晨测数据 */
function analyzeLog({ sessions = [], morning = [], profile = {}, plan = null, as_of = null }) {
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
  return analyze(athlete, { plan, asOf: as_of });
}

module.exports = { analyze, analyzeLog };
