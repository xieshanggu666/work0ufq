"use strict";
/* 训练处方与周期化：
   - 由当日 ACWR 与准备度推导目标强度区间与负荷范围
   - 目标负荷 = 慢性负荷 × 期望 ACWR - 本周已积累负荷（非负）
   - 周周期化：四周递进块（基准 → +8% → +16% → 减载 60%），
     非减载周相邻周增幅不超过 10% 经验阈值 */

const { acwrBand } = require("./models");

const ZONES = {
  z1: { key: "z1", label: "Z1 恢复区", hr: "50-60% HRR", desc: "低强度有氧，用于恢复与热身" },
  z2: { key: "z2", label: "Z2 有氧耐力区", hr: "60-70% HRR", desc: "基础有氧耐力，可长时间维持" },
  z3: { key: "z3", label: "Z3 节奏区", hr: "70-80% HRR", desc: "节奏训练，改善乳酸阈值" },
  z4: { key: "z4", label: "Z4 阈值区", hr: "80-90% HRR", desc: "阈值间歇，提升最大摄氧能力" },
  z5: { key: "z5", label: "Z5 无氧区", hr: "90-100% HRR", desc: "高强度间歇，刺激无氧能力" },
};

/* 按 ACWR 与准备度选择今日强度区间与负荷上限比例 */
function todayIntensity(acwr, readiness) {
  const band = acwrBand(acwr);
  if (band.key === "insufficient" || readiness == null) {
    return { zone: ZONES.z1, load_ratio: 0.5, note: "历史数据不足，以低强度恢复性训练起步" };
  }
  if (band.key === "danger" || readiness < 40) {
    return { zone: ZONES.z1, load_ratio: 0.4, note: "负荷过高或恢复不足，执行恢复性低强度训练" };
  }
  if (band.key === "caution" || readiness < 60) {
    return { zone: ZONES.z2, load_ratio: 0.65, note: "负荷偏高或状态一般，降低强度与时长" };
  }
  if (band.key === "under") {
    return { zone: ZONES.z3, load_ratio: 0.85, note: "近期负荷偏低，可适度提升训练量" };
  }
  return { zone: ZONES.z3, load_ratio: 1.0, note: "处于适宜负荷区间，按计划训练" };
}

/* 今日目标负荷：基于慢性负荷与期望 ACWR 区间 */
function targetLoad(chronic, weekAccumulated, targetAcwr = 1.0) {
  if (chronic <= 0) return null;
  const want = chronic * targetAcwr;
  return Math.max(0, Math.round(want - weekAccumulated));
}

/* 四周边期化：base 周负荷（可用近 4 周均值代替），返回各周目标与增幅 */
function periodizeWeeks(base, opts = {}) {
  const increment = opts.increment != null ? opts.increment : 0.08;
  const deload = opts.deload != null ? opts.deload : 0.6;
  const weeks = [
    { week: 1, label: "第 1 周", target: Math.round(base), deload: false },
    { week: 2, label: "第 2 周", target: Math.round(base * (1 + increment)), deload: false },
    { week: 3, label: "第 3 周", target: Math.round(base * (1 + 2 * increment)), deload: false },
    { week: 4, label: "第 4 周（减载）", target: Math.round(base * (1 + 2 * increment) * deload), deload: true },
  ];
  const out = weeks.map((w, i) => {
    const prev = i > 0 ? weeks[i - 1].target : null;
    const delta = prev ? Math.round(((w.target - prev) / prev) * 1000) / 10 : null;
    return { ...w, prev, delta_pct: delta };
  });
  const deloadIdx = out.findIndex(w => w.deload);
  const maxProg = Math.max(...out.filter(w => !w.deload && w.prev != null).map(w => Math.abs(w.delta_pct)));
  return { weeks: out, max_progression_pct: maxProg, deload_week: deloadIdx + 1 };
}

/* 今日处方完整输出 */
function prescribe(state) {
  const intensity = todayIntensity(state.acwr, state.readiness);
  const t = targetLoad(state.chronic, state.week_accumulated);
  const band = acwrBand(state.acwr);
  return {
    date: state.date,
    acwr: state.acwr,
    acwr_band: band,
    readiness: state.readiness,
    readiness_label: state.readinessLabel || null,
    intensity: intensity,
    suggested_load: t,
    suggested_range: t != null ? [Math.round(t * 0.9), Math.round(t * 1.1)] : null,
    note: intensity.note,
  };
}

module.exports = { ZONES, todayIntensity, targetLoad, periodizeWeeks, prescribe };
