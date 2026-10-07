"use strict";
/* 恢复状态模型：
   - rMSSD（连续 RR 间期差值的均方根）
   - HRV 基线（近 7 日晨测 rMSSD 均值）与 HRV 平衡
   - 睡眠债与睡眠恢复指数
   - 静息心率漂移（较 7 日均值升高表示疲劳累积）
   - 综合准备度评分（多因子加权，权重归一化） */

/* rMSSD：sqrt( mean( (RR[i+1]-RR[i])^2 ) ) */
function rmssd(rr) {
  if (!rr || rr.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < rr.length - 1; i++) {
    const d = rr[i + 1] - rr[i];
    sum += d * d;
  }
  return Math.sqrt(sum / (rr.length - 1));
}

/* 简单滑动均值 */
function rollingMean(values, n) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - n + 1);
    const slice = values.slice(from, i + 1);
    out.push(slice.reduce((s, x) => s + x, 0) / slice.length);
  }
  return out;
}

/* 心率变异平衡：今日 rMSSD / 基线（近 7 日，含今日） */
function hrvBalance(hrvDaily) {
  const vals = hrvDaily.map(d => d.rmssd);
  const base = rollingMean(vals, 7);
  return hrvDaily.map((d, i) => {
    const b = base[i];
    return {
      date: d.date,
      rmssd: round2(d.rmssd),
      baseline: round2(b),
      balance: b > 0 ? round2(d.rmssd / b) : 1,
    };
  });
}

/* 静息心率漂移：近 7 日均值 vs 更早 7 日均值 */
function rhrDrift(rhrDaily) {
  const vals = rhrDaily.map(d => d.rhr);
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const a = vals.slice(Math.max(0, i - 6), i + 1); // 近 7 日
    const b = vals.slice(Math.max(0, i - 13), Math.max(0, i - 6)); // 前 7 日
    const ma = a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
    const mb = b.length ? b.reduce((s, x) => s + x, 0) / b.length : 0;
    out.push({ date: rhrDaily[i].date, rhr: round2(vals[i]), recent: round2(ma), drift: mb > 0 ? round2(ma - mb) : 0 });
  }
  return out;
}

/* 睡眠债：逐日累计（不足补足，充足则回补），封顶 12 小时 */
function sleepDebt(sleepHours, need = 7.5) {
  let debt = 0;
  const out = [];
  for (const h of sleepHours) {
    debt = Math.max(0, Math.min(12, debt + (need - h)));
    out.push(round2(debt));
  }
  return out;
}

/* 综合准备度评分（0-100）：
   HRV 平衡 / 睡眠 / 主观精力 / 肌肉酸痛 / 负荷压力 五项加权，
   权重内部归一化，保证总分在 0-100 区间。 */
const READINESS_WEIGHTS = { hrv: 0.25, sleep: 0.25, energy: 0.20, soreness: 0.15, load: 0.15 };

function readinessScore(h, sleepScore, energy, soreness, loadPressure) {
  const norm = READINESS_WEIGHTS.hrv + READINESS_WEIGHTS.sleep + READINESS_WEIGHTS.energy + READINESS_WEIGHTS.soreness + READINESS_WEIGHTS.load;
  const hrvPart = clamp01((h - 0.7) / 0.6); // balance 0.7→0, 1.3→1
  const sleepPart = clamp01(sleepScore / 100);
  const energyPart = clamp01(energy / 100);
  const sorePart = clamp01(1 - soreness / 100);
  const loadPart = clamp01(1 - loadPressure / 100);
  const score = (READINESS_WEIGHTS.hrv * hrvPart + READINESS_WEIGHTS.sleep * sleepPart + READINESS_WEIGHTS.energy * energyPart + READINESS_WEIGHTS.soreness * sorePart + READINESS_WEIGHTS.load * loadPart) / norm;
  return Math.round(score * 100);
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function readinessLabel(score) {
  if (score >= 80) return { key: "ready", label: "状态极佳", color: "#2e8b57" };
  if (score >= 60) return { key: "ok", label: "状态良好", color: "#5b8db8" };
  if (score >= 40) return { key: "fair", label: "状态一般", color: "#d98e2b" };
  return { key: "tired", label: "需要休息", color: "#c0392b" };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

module.exports = {
  rmssd,
  rollingMean,
  hrvBalance,
  rhrDrift,
  sleepDebt,
  readinessScore,
  readinessLabel,
  READINESS_WEIGHTS,
};
