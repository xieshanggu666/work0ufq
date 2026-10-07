"use strict";
const assert = require("assert");
const M = require("../engine/models");
const R = require("../engine/recovery");
const P = require("../engine/prescribe");
const A = require("../engine/athlete");
const AN = require("../engine/analyzer");

let passed = 0;
let failed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log("ok  -", name);
  } catch (e) {
    failed++;
    console.log("FAIL -", name, "::", e.message);
  }
}

/* ---------- 负荷模型 ---------- */
t("sRPE 主观负荷 = RPE × 时长", () => {
  assert.strictEqual(M.srpeLoad(7, 60), 420);
  assert.strictEqual(M.srpeLoad(3, 45), 135);
});

t("Banister TRIMP 手算一致（ΔHR比=0.5）", () => {
  const v = M.banisterTrimp(60, 120, 55, 185, "m");
  const expected = 60 * 0.5 * 1.92 * Math.exp(1.92 * 0.5);
  assert(Math.abs(v - expected) < 1e-6);
});

t("Edwards TRIMP 区间加权", () => {
  assert.strictEqual(M.edwardsTrimp(60, 120, 55, 185), 60);   // 50% HRR → Z1 权重 1
  assert.strictEqual(M.edwardsTrimp(30, 140, 55, 185), 60);   // 65% HRR → Z2 权重 2
  assert.strictEqual(M.edwardsTrimp(30, 159, 55, 185), 120);  // 80% HRR → Z4 权重 4
});

t("心率区间边界划分", () => {
  assert.strictEqual(M.hrZone(132, 55, 185), 1); // 59.2% → Z1
  assert.strictEqual(M.hrZone(133, 55, 185), 2); // 60% → Z2
  assert.strictEqual(M.hrZone(159, 55, 185), 4); // 80% → Z4
});

t("EWMA 首值预热与递推", () => {
  const e = M.ewma([10, 20, 30], 2); // λ=2/3
  assert.strictEqual(e[0], 10);
  assert(Math.abs(e[1] - (2 / 3 * 20 + 1 / 3 * 10)) < 1e-9);
  assert(Math.abs(e[2] - (2 / 3 * 30 + 1 / 3 * e[1])) < 1e-9);
});

t("恒定负荷下 ACWR 收敛为 1", () => {
  const daily = Array.from({ length: 35 }, (_, i) => ({ date: "2026-01-" + String(i + 1).padStart(2, "0"), load: 100 }));
  const s = M.acwrSeries(daily);
  assert(Math.abs(s[34].acwr - 1) < 1e-9);
});

t("ACWR 慢性起点取首值（预热）", () => {
  const daily = Array.from({ length: 8 }, (_, i) => ({ date: "2026-01-" + String(i + 1).padStart(2, "0"), load: 50 + i * 25 }));
  const s = M.acwrSeries(daily);
  assert.strictEqual(s[0].chronic, 50);
});

t("负荷骤升进入危险区间", () => {
  const daily = [];
  for (let i = 0; i < 28; i++) daily.push({ date: "2026-01-" + String(i + 1).padStart(2, "0"), load: 200 });
  for (let i = 28; i < 35; i++) daily.push({ date: "2026-02-" + String(i - 27).padStart(2, "0"), load: 900 });
  const s = M.acwrSeries(daily);
  assert(s[34].acwr > 1.5);
  assert.strictEqual(M.acwrBand(s[34].acwr).key, "danger");
  assert.strictEqual(M.acwrBand(0.9).key, "sweet");
  assert.strictEqual(M.acwrBand(0.5).key, "under");
  assert.strictEqual(M.acwrBand(1.4).key, "caution");
});

t("单调性：完全重复负荷时封顶 999", () => {
  const daily = Array.from({ length: 7 }, (_, i) => ({ date: "2026-01-" + String(i + 1).padStart(2, "0"), load: 300 }));
  const m = M.monotonyStrain(daily);
  assert.strictEqual(m.monotony, 999);
  assert(m.strain > 0);
});

t("单调性：变化负荷手算", () => {
  const daily = [
    { date: "2026-01-01", load: 100 }, { date: "2026-01-02", load: 200 }, { date: "2026-01-03", load: 300 },
    { date: "2026-01-04", load: 100 }, { date: "2026-01-05", load: 200 }, { date: "2026-01-06", load: 300 },
    { date: "2026-01-07", load: 200 },
  ];
  const m = M.monotonyStrain(daily);
  const mean = 200;
  const sd = Math.sqrt((10000 + 0 + 10000 + 10000 + 0 + 10000 + 0) / 7);
  assert(Math.abs(m.mean - mean) < 1e-9);
  assert.strictEqual(m.monotony, Math.round((mean / sd) * 100) / 100);
});

t("体能-疲劳：疲劳更快逼近稳态（响应更快）", () => {
  const daily = [];
  for (let i = 0; i < 7; i++) daily.push({ date: "2026-01-" + String(i + 1).padStart(2, "0"), load: 0 });
  for (let i = 7; i < 14; i++) daily.push({ date: "2026-01-" + String(i + 1).padStart(2, "0"), load: 900 });
  const ff = M.fitnessFatigue(daily);
  const steadyFit = 900 / (1 - Math.exp(-1 / M.TAU_FIT));
  const steadyFat = 900 / (1 - Math.exp(-1 / M.TAU_FAT));
  assert(ff[13].fatigue / steadyFat > ff[13].fitness / steadyFit);
});

t("体能-疲劳：休息后疲劳衰减快于体能且表现回升", () => {
  const daily = [];
  for (let i = 0; i < 7; i++) daily.push({ date: "2026-01-" + String(i + 1).padStart(2, "0"), load: 900 });
  for (let i = 7; i < 21; i++) daily.push({ date: "2026-01-" + String(i + 1).padStart(2, "0"), load: 0 });
  const ff = M.fitnessFatigue(daily);
  const blockEnd = ff[6];
  const restEnd = ff[20];
  assert(restEnd.fatigue / blockEnd.fatigue < restEnd.fitness / blockEnd.fitness);
  assert(restEnd.performance > blockEnd.performance);
});

t("时间常数：体能 42 天 > 疲劳 8 天", () => {
  assert(M.TAU_FIT > M.TAU_FAT);
});

/* ---------- 恢复模型 ---------- */
t("rMSSD 手算一致", () => {
  assert.strictEqual(R.rmssd([800, 810, 800, 810]), 10);
  assert.strictEqual(R.rmssd([800]), 0);
  assert.strictEqual(R.rmssd([]), 0);
});

t("HRV 平衡 = 当日 / 近 7 日均值", () => {
  const daily = [];
  for (let i = 0; i < 6; i++) daily.push({ date: "2026-01-" + String(i + 1).padStart(2, "0"), rmssd: 70 });
  daily.push({ date: "2026-01-07", rmssd: 84 });
  const h = R.hrvBalance(daily);
  const base = (6 * 70 + 84) / 7;
  assert(Math.abs(h[6].baseline - base) < 1e-9);
  assert.strictEqual(h[6].balance, Math.round((84 / base) * 100) / 100);
});

t("睡眠债逐日累计且封顶 12 小时", () => {
  const d = R.sleepDebt([6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6], 7.5);
  assert.strictEqual(d[0], 1.5);
  assert(d[15] <= 12);
  const d2 = R.sleepDebt([8, 5], 7.5);
  assert.strictEqual(d2[0], 0);
  assert.strictEqual(d2[1], 2.5);
});

t("静息心率漂移反映近期均值差", () => {
  const daily = [];
  for (let i = 0; i < 7; i++) daily.push({ date: "2026-01-" + String(i + 1).padStart(2, "0"), rhr: 55 });
  for (let i = 7; i < 10; i++) daily.push({ date: "2026-01-" + String(i + 1).padStart(2, "0"), rhr: 60 });
  const r = R.rhrDrift(daily);
  assert(r[7].drift > 0);
  assert.strictEqual(r[0].drift, 0);
});

t("准备度评分落在 0-100", () => {
  for (let i = 0; i < 20; i++) {
    const s = R.readinessScore(0.6 + i * 0.05, 40 + i * 3, 30 + i * 3, 80 - i * 3, 20 + i * 3);
    assert(s >= 0 && s <= 100);
  }
});

t("准备度随 HRV 平衡单调上升（其余固定）", () => {
  const a = R.readinessScore(0.8, 70, 70, 30, 30);
  const b = R.readinessScore(1.2, 70, 70, 30, 30);
  assert(b > a);
});

t("准备度随酸痛上升而下降", () => {
  const a = R.readinessScore(1.0, 70, 70, 10, 30);
  const b = R.readinessScore(1.0, 70, 70, 90, 30);
  assert(a > b);
});

/* ---------- 处方 ---------- */
t("处方：危险 ACWR 给恢复区", () => {
  const p = P.todayIntensity(1.7, 70);
  assert.strictEqual(p.zone.key, "z1");
  assert.strictEqual(p.load_ratio, 0.4);
});

t("处方：低准备度给恢复区", () => {
  const p = P.todayIntensity(1.0, 30);
  assert.strictEqual(p.zone.key, "z1");
});

t("处方：适宜区间+高准备度给节奏区", () => {
  const p = P.todayIntensity(1.0, 85);
  assert.strictEqual(p.zone.key, "z3");
  assert.strictEqual(p.load_ratio, 1.0);
});

t("处方：数据不足给低强度起步", () => {
  const p = P.todayIntensity(null, null);
  assert.strictEqual(p.zone.key, "z1");
});

t("目标负荷 = 慢性×期望ACWR - 本周已积累", () => {
  assert.strictEqual(P.targetLoad(1000, 300), 700);
  assert.strictEqual(P.targetLoad(1000, 1200), 0);
  assert.strictEqual(P.targetLoad(0, 100), null);
});

t("周期化：四周块与减载，增幅不超阈值", () => {
  const p = P.periodizeWeeks(500, {});
  assert.deepStrictEqual(p.weeks.map(w => w.target), [500, 540, 580, 348]);
  assert.strictEqual(p.deload_week, 4);
  assert(p.max_progression_pct <= 10);
  assert.strictEqual(p.weeks[3].deload, true);
});

/* ---------- 合成数据 ---------- */
t("同种子生成完全一致（确定性）", () => {
  const a = A.generateAthlete({ seed: 42, weeks: 6 });
  const b = A.generateAthlete({ seed: 42, weeks: 6 });
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});

t("不同种子生成不同历史", () => {
  const a = A.generateAthlete({ seed: 1, weeks: 6 });
  const b = A.generateAthlete({ seed: 2, weeks: 6 });
  assert.notStrictEqual(JSON.stringify(a), JSON.stringify(b));
});

t("合成数据字段边界合法", () => {
  const a = A.generateAthlete({ seed: 7, weeks: 6, sex: "f" });
  for (const s of a.sessions) {
    assert(s.date >= "2026-03-02");
    assert(s.minutes >= 20 && s.minutes <= 140);
    assert(s.rpe >= 1 && s.rpe <= 10);
    assert(s.avg_hr >= s.rest_hr && s.avg_hr <= s.max_hr);
  }
  for (const m of a.morning) {
    assert(m.rmssd >= 20 && m.rmssd <= 130);
    assert(m.sleep >= 5 && m.sleep <= 10.5);
    assert(m.energy >= 0 && m.energy <= 100);
    assert(m.soreness >= 0 && m.soreness <= 100);
  }
});

t("周负荷随周期化递进且减载周下降", () => {
  const a = A.generateAthlete({ seed: 11, weeks: 8 });
  assert.strictEqual(a.weekly_target.length, 8);
  assert(a.weekly_target[1] > a.weekly_target[0]);
  assert(a.weekly_target[3] < a.weekly_target[2]);
});

/* ---------- 日负荷与聚合 ---------- */
t("日负荷聚合且缺失日期补零", () => {
  const sessions = [
    { date: "2026-03-02", rpe: 5, minutes: 60, avg_hr: 120, rest_hr: 55, max_hr: 185, sex: "m" },
    { date: "2026-03-04", rpe: 8, minutes: 45, avg_hr: 150, rest_hr: 55, max_hr: 185, sex: "m" },
  ];
  const d = M.dailyLoads(sessions);
  assert.strictEqual(d.length, 3);
  assert.strictEqual(d[0].load, 300);
  assert.strictEqual(d[1].load, 0);
  assert.strictEqual(d[2].load, 360);
});

t("多会话同日累加", () => {
  const sessions = [
    { date: "2026-03-02", rpe: 5, minutes: 60, avg_hr: 120, rest_hr: 55, max_hr: 185, sex: "m" },
    { date: "2026-03-02", rpe: 3, minutes: 30, avg_hr: 100, rest_hr: 55, max_hr: 185, sex: "m" },
  ];
  assert.strictEqual(M.dailyLoads(sessions)[0].load, 390);
});

t("三种负荷口径口径不同且各自稳定", () => {
  const s = { date: "2026-03-02", rpe: 7, minutes: 60, avg_hr: 155, rest_hr: 55, max_hr: 185, sex: "m" };
  const L = M.sessionLoads(s);
  assert(L.srpe === 420);
  assert(L.trimp > 0 && L.edwards > 0);
  assert(Math.abs(L.trimp - L.edwards) > 1);
});

/* ---------- 端到端分析 ---------- */
const ATH = A.generateAthlete({ seed: 20261007, weeks: 8, sex: "m" });
const RES = AN.analyze(ATH);

t("端到端：逐日序列长度与周数匹配", () => {
  assert.strictEqual(RES.days.length, 8 * 7);
});

t("端到端：今日 ACWR 与区间有效", () => {
  assert(RES.today.acwr != null);
  assert(RES.today.band.key !== undefined);
});

t("端到端：准备度逐日取值合法", () => {
  for (const d of RES.days) {
    assert(d.score >= 0 && d.score <= 100);
  }
});

t("端到端：处方建议负荷非负或为 null", () => {
  assert(RES.prescription.suggested_load === null || RES.prescription.suggested_load >= 0);
});

t("端到端：单调性应变与周负荷为正", () => {
  assert(RES.monotony_strain.weekly_load > 0);
  assert(RES.monotony_strain.strain > 0);
});

t("端到端：统计汇总合理", () => {
  assert(RES.totals.sessions > 0);
  assert(RES.totals.total_load > 0);
  assert(RES.totals.avg_rmssd >= 20);
});

t("空日志分析可安全返回", () => {
  const r = AN.analyzeLog({ sessions: [], morning: [], profile: { sleep_need: 7.5 } });
  assert.strictEqual(r.today.acwr, null);
  assert.strictEqual(r.prescription.intensity.zone.key, "z1");
});

t("自定义日志分析覆盖区间补全晨测", () => {
  const sessions = [
    { date: "2026-03-02", rpe: 5, minutes: 60, avg_hr: 120, rest_hr: 55, max_hr: 185, sex: "m" },
    { date: "2026-03-03", rpe: 6, minutes: 50, avg_hr: 130, rest_hr: 55, max_hr: 185, sex: "m" },
  ];
  const r = AN.analyzeLog({ sessions, profile: { sleep_need: 7.5 } });
  assert.strictEqual(r.days.length, 2);
  assert.strictEqual(r.days[1].rmssd, 70);
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
