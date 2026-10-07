"use strict";
/* 训练负荷模型：
   - sRPE 主观负荷 = RPE × 时长
   - Banister TRIMP：基于心率储备的指数加权积分
   - Edwards TRIMP：五区间带权累加
   - 日负荷序列（按日期聚合会话）
   - EWMA 平滑（含预热期）
   - ACWR 急性 / 慢性负荷比（急性 7 日、慢性 28 日）
   - 单调性 Monotony 与应变 Strain
   - Banister 体能-疲劳脉冲响应模型（离散递推） */

const { fmtLocal, parseIso } = require("./date");

const SEX_K = { m: 1.92, f: 1.67 };

/* 主观负荷 */
function srpeLoad(rpe, minutes) {
  return rpe * minutes;
}

/* Banister TRIMP：minutes × ΔHR比 × k × e^(k × ΔHR比) */
function banisterTrimp(minutes, avgHr, restHr, maxHr, sex) {
  const reserve = maxHr - restHr;
  if (reserve <= 0) return 0;
  const ratio = (avgHr - restHr) / reserve;
  if (ratio <= 0) return 0;
  const k = SEX_K[sex] || SEX_K.m;
  return minutes * ratio * k * Math.exp(k * ratio);
}

/* 心率区间：按 %HRR 划分五区 */
function hrZone(avgHr, restHr, maxHr) {
  const reserve = maxHr - restHr;
  if (reserve <= 0) return 1;
  const pct = ((avgHr - restHr) / reserve) * 100;
  if (pct < 60) return 1;
  if (pct < 70) return 2;
  if (pct < 80) return 3;
  if (pct < 90) return 4;
  return 5;
}

/* Edwards TRIMP 区间权重 */
const EDWARDS_FACTOR = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 };

function edwardsTrimp(minutes, avgHr, restHr, maxHr) {
  const z = hrZone(avgHr, restHr, maxHr);
  return minutes * EDWARDS_FACTOR[z];
}

/* 单次会话的多口径负荷 */
function sessionLoads(s) {
  const srpe = srpeLoad(s.rpe, s.minutes);
  const trimp = banisterTrimp(s.minutes, s.avg_hr, s.rest_hr, s.max_hr, s.sex);
  const edwards = edwardsTrimp(s.minutes, s.avg_hr, s.rest_hr, s.max_hr);
  return { srpe, trimp, edwards };
}

/* 按日期聚合为日负荷序列；缺失日期以 0 填充（视为休息日）。
   range 可选：[min, max] 指定覆盖区间，否则取会话日期最小-最大。 */
function dailyLoads(sessions, loadKey = "srpe", range = null) {
  const map = new Map();
  let min = range ? range[0] : null;
  let max = range ? range[1] : null;
  for (const s of sessions) {
    const d = s.date;
    map.set(d, (map.get(d) || 0) + sessionLoads(s)[loadKey]);
    if (!range) {
      if (min === null || d < min) min = d;
      if (max === null || d > max) max = d;
    }
  }
  if (!min || !max) return [];
  const out = [];
  const cur = parseIso(min);
  const end = parseIso(max);
  while (cur <= end) {
    const key = fmtLocal(cur);
    out.push({ date: key, load: map.get(key) || 0 });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/* EWMA：λ = 2/(N+1)；首值直接取初始值作为预热起点 */
function ewma(values, n) {
  const lambda = 2 / (n + 1);
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i === 0) out.push(values[0]);
    else out.push(lambda * values[i] + (1 - lambda) * out[i - 1]);
  }
  return out;
}

/* 急性 / 慢性负荷比；慢性为 0 时返回 null（数据不足） */
function acwrSeries(daily, acuteN = 7, chronicN = 28) {
  const loads = daily.map(d => d.load);
  if (loads.length < 1) return [];
  const acute = ewma(loads, acuteN);
  const chronic = ewma(loads, chronicN);
  return daily.map((d, i) => ({
    date: d.date,
    load: d.load,
    acute: round2(acute[i]),
    chronic: round2(chronic[i]),
    acwr: chronic[i] > 0 ? round2(acute[i] / chronic[i]) : null,
  }));
}

/* 单调性与应变：取最近 7 日窗口；SD 为 0 时单调性视为极高并封顶 */
function monotonyStrain(daily, window = 7) {
  const tail = daily.slice(-window).map(d => d.load);
  if (tail.length < 2) return { monotony: 0, strain: 0, mean: 0, sd: 0, weekly_load: 0 };
  const mean = tail.reduce((s, x) => s + x, 0) / tail.length;
  const sd = Math.sqrt(tail.reduce((s, x) => s + (x - mean) * (x - mean), 0) / tail.length);
  const weekly_load = tail.reduce((s, x) => s + x, 0);
  let monotony = 0;
  if (sd > 1e-9) monotony = mean / sd;
  else if (mean > 0) monotony = 999; // 完全重复的负荷 → 极高单调性，封顶防溢出
  return { monotony: round2(Math.min(monotony, 999)), strain: round2(weekly_load * Math.min(monotony, 999)), mean: round2(mean), sd: round2(sd), weekly_load: round2(weekly_load) };
}

/* Banister 体能-疲劳脉冲响应：离散递推
   fitness 时间常数大于 fatigue（体能慢积累慢衰减，疲劳快响应快消退） */
const TAU_FIT = 42;
const TAU_FAT = 8;

function fitnessFatigue(daily) {
  let fit = 0;
  let fat = 0;
  const kFit = Math.exp(-1 / TAU_FIT);
  const kFat = Math.exp(-1 / TAU_FAT);
  return daily.map(d => {
    fit = fit * kFit + d.load;
    fat = fat * kFat + d.load;
    const perf = fit - fat;
    return { date: d.date, load: d.load, fitness: round2(fit), fatigue: round2(fat), performance: round2(perf) };
  });
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

/* ACWR 分类 */
function acwrBand(acwr) {
  if (acwr === null || acwr === undefined) return { key: "insufficient", label: "数据不足", color: "#9aa5a0" };
  if (acwr < 0.8) return { key: "under", label: "负荷偏低", color: "#5b8db8" };
  if (acwr <= 1.3) return { key: "sweet", label: "负荷适宜", color: "#2e8b57" };
  if (acwr <= 1.5) return { key: "caution", label: "负荷偏高", color: "#d98e2b" };
  return { key: "danger", label: "负荷过高", color: "#c0392b" };
}

module.exports = {
  srpeLoad,
  banisterTrimp,
  edwardsTrimp,
  hrZone,
  EDWARDS_FACTOR,
  sessionLoads,
  dailyLoads,
  ewma,
  acwrSeries,
  monotonyStrain,
  fitnessFatigue,
  acwrBand,
  TAU_FIT,
  TAU_FAT,
  SEX_K,
};
