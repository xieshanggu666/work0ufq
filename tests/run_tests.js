"use strict";
const assert = require("assert");
const M = require("../engine/models");
const R = require("../engine/recovery");
const P = require("../engine/prescribe");
const A = require("../engine/athlete");
const AN = require("../engine/analyzer");
const PL = require("../engine/plan");

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

/* ---------- 协作计划：周期与日程 ---------- */
t("计划：生成草稿，日程覆盖全部天数且周日休息", () => {
  const plan = PL.buildPlan({ start_date: "2026-04-06", weeks: 6, base_load: 500 });
  assert.strictEqual(plan.status, "draft");
  assert.strictEqual(plan.schedule.length, 42);
  assert.strictEqual(plan.weekly_targets.length, 6);
  assert.strictEqual(plan.schedule[6].is_rest, true);
  assert.strictEqual(plan.schedule[6].target_load, 0);
  assert(plan.schedule[5].sessions.length === 2);
  assert.strictEqual(plan.schedule[5].target_load,
    plan.schedule[5].sessions.reduce((s, x) => s + x.planned_load, 0));
});

t("计划：四周块递进后减载", () => {
  const ts = PL.weeklyTargets(500, 4, 0.08, 0.6);
  assert.deepStrictEqual(ts.map(w => w.target), [500, 540, 580, 348]);
  assert.strictEqual(ts[3].deload, true);
});

t("计划：day_overrides 可强制休息日", () => {
  const plan = PL.buildPlan({
    start_date: "2026-04-06", weeks: 1,
    day_overrides: { "2026-04-06": { rest: true } },
  });
  assert.strictEqual(plan.schedule[0].is_rest, true);
});

t("计划：修订仅允许在草稿态，版本递增并保留时间线", () => {
  const plan = PL.buildPlan({ weeks: 4 });
  const v = plan.version;
  PL.rebuildPlan(plan, { weeks: 6 });
  assert.strictEqual(plan.weeks, 6);
  assert.strictEqual(plan.version, v + 1);
  assert(plan.timeline.some(e => e.action === "edit"));
  assert.throws(() => {
    PL.transition(plan, "submit", { role: "coach" });
    PL.rebuildPlan(plan, { weeks: 4 });
  });
});

/* ---------- 协作计划：状态机与权限 ---------- */
t("计划：低风险可经教练提交→运动员确认→执行→暂停→恢复→归档", () => {
  const plan = PL.buildPlan({ weeks: 4, base_load: 500, increment: 0.05 });
  PL.transition(plan, "submit", { role: "coach", risk: { review_required: false, level: "low", factors: [] } });
  assert.strictEqual(plan.status, "pending_confirmation");
  assert.strictEqual(plan.review, null);
  PL.transition(plan, "confirm", { role: "athlete" });
  assert.strictEqual(plan.status, "executing");
  assert(plan.confirmation.confirmed_at);
  PL.transition(plan, "pause", { role: "athlete" });
  assert.strictEqual(plan.status, "paused");
  PL.transition(plan, "resume", { role: "coach", risk: { review_required: false, level: "low", factors: [] } });
  assert.strictEqual(plan.status, "executing");
  PL.transition(plan, "archive", { role: "coach" });
  assert.strictEqual(plan.status, "archived");
});

t("计划：非法角色或非法状态流转被拒绝", () => {
  const plan = PL.buildPlan({ weeks: 4 });
  assert.throws(() => PL.transition(plan, "confirm", { role: "athlete" })); // 草稿不可确认
  assert.throws(() => PL.transition(plan, "submit", { role: "athlete" })); // 运动员不可提交
  PL.transition(plan, "submit", { role: "coach", risk: { review_required: false, level: "low", factors: [] } });
  assert.throws(() => PL.transition(plan, "review", { role: "coach" })); // 无 review 动作
});

t("计划：高风险提交后挂起康复师复核，复核通过方可确认", () => {
  const plan = PL.buildPlan({ weeks: 4, base_load: 500, increment: 0.25 });
  const risk = PL.assessRisk(plan, {});
  assert.strictEqual(risk.review_required, true);
  PL.transition(plan, "submit", { role: "coach", risk });
  assert.strictEqual(plan.review.status, "pending");
  assert.throws(() => PL.transition(plan, "confirm", { role: "athlete" }));
  assert.throws(() => PL.review(plan, { role: "coach", decision: "approve" }));
  PL.review(plan, { role: "therapist", decision: "approve", actor: "康复师王", note: "加强监控" });
  assert.strictEqual(plan.review.status, "approved");
  PL.transition(plan, "confirm", { role: "athlete" });
  assert.strictEqual(plan.status, "executing");
});

t("计划：康复师退回修改后回到草稿，须重新提交", () => {
  const plan = PL.buildPlan({ weeks: 4, increment: 0.25 });
  PL.transition(plan, "submit", { role: "coach", risk: PL.assessRisk(plan, {}) });
  PL.review(plan, { role: "therapist", decision: "request_changes", note: "增幅过大" });
  assert.strictEqual(plan.status, "draft");
  assert.strictEqual(plan.review.status, "changes_requested");
});

t("计划：暂停后恢复时若仍高风险，退回待确认复核", () => {
  const plan = PL.buildPlan({ weeks: 4 });
  PL.transition(plan, "submit", { role: "coach", risk: { review_required: false, level: "low", factors: [] } });
  PL.transition(plan, "confirm", { role: "athlete" });
  PL.transition(plan, "pause", { role: "coach" });
  PL.transition(plan, "resume", { role: "coach", risk: PL.assessRisk(PL.buildPlan({ weeks: 4, increment: 0.25 }), {}) });
  assert.strictEqual(plan.status, "pending_confirmation");
  assert.strictEqual(plan.review.status, "pending");
});

/* ---------- 协作计划：风险评估 ---------- */
t("风险：周增幅 >20% 判高风险，10-20% 为关注", () => {
  assert.strictEqual(PL.assessRisk(PL.buildPlan({ weeks: 4, increment: 0.25 }), {}).level, "high");
  assert.strictEqual(PL.assessRisk(PL.buildPlan({ weeks: 4, increment: 0.12 }), {}).level, "warn");
  assert.strictEqual(PL.assessRisk(PL.buildPlan({ weeks: 4, increment: 0.05 }), {}).level, "low");
});

t("风险：当前 ACWR / 准备度纳入评估", () => {
  const plan = PL.buildPlan({ weeks: 4, increment: 0.05 });
  assert.strictEqual(PL.assessRisk(plan, { acwr: 1.6, readiness: 80 }).level, "high");
  assert.strictEqual(PL.assessRisk(plan, { acwr: 1.0, readiness: 50 }).level, "warn");
});

t("风险：首周冲击慢性负荷触发高风险", () => {
  const plan = PL.buildPlan({ weeks: 4, base_load: 1000, increment: 0.05 });
  const r = PL.assessRisk(plan, { chronic: 80 }); // 慢性周负荷 560，首周 1000 → 1.79
  assert.strictEqual(r.level, "high");
  assert(r.factors.some(f => f.code === "first_week_load"));
});

/* ---------- 协作计划：负荷投影 ---------- */
t("投影：实际历史 + 未来计划拼接，峰值出现在未来", () => {
  const plan = PL.buildPlan({ start_date: "2026-03-09", weeks: 4, base_load: 900, increment: 0.08 });
  const sessions = [];
  for (let day = 0; day < 7; day++) {
    sessions.push({ date: "2026-03-" + String(2 + day).padStart(2, "0"), rpe: 5, minutes: 60, avg_hr: 130, rest_hr: 55, max_hr: 196, sex: "m" });
  }
  const proj = PL.projectLoads(sessions, plan, "2026-03-08");
  assert.strictEqual(proj.daily.filter(d => d.kind === "actual").length, 7);
  assert(proj.daily.some(d => d.kind === "planned"));
  assert(proj.peak_acwr != null);
  assert(proj.peak_date >= "2026-03-09");
});

t("执行风险：危险 ACWR 或低准备度判高并建议降级", () => {
  const plan = PL.buildPlan({ start_date: "2026-03-09", weeks: 4 });
  const r = PL.executionRisk(plan, { date: "2026-03-09", acwr: 1.7, readiness: 80, week_accumulated: 300 });
  assert.strictEqual(r.level, "high");
  const r2 = PL.executionRisk(plan, { date: "2026-03-09", acwr: 1.0, readiness: 80, week_accumulated: 1 });
  assert.strictEqual(r2.level, "low");
  assert.strictEqual(PL.executionRisk(plan, { date: "2026-03-15", acwr: 1.0, readiness: 80, week_accumulated: 0 }).is_rest_day, true);
});

/* ---------- 协作计划：回写 ---------- */
t("回写：准备度 / 负荷窗口 / 每日处方留痕（同日覆盖）", () => {
  const plan = PL.buildPlan({ start_date: "2026-03-09", weeks: 4 });
  PL.writeReadiness(plan, { date: "2026-03-09", score: 72, label: { key: "ok" } });
  PL.writeReadiness(plan, { date: "2026-03-09", score: 68 });
  assert.strictEqual(plan.writeback.readiness_snapshots.length, 1);
  assert.strictEqual(plan.writeback.readiness_snapshots[0].score, 68);
  PL.writePrescription(plan, {
    date: "2026-03-09", intensity: { zone: { key: "z3", label: "节奏区" } },
    suggested_load: 400, suggested_range: [360, 440], planned_load: 400, plan_status: "planned", note: "按计划",
  });
  assert.strictEqual(plan.writeback.daily_prescriptions[0].zone, "z3");
  assert.throws(() => PL.writeReadiness(plan, { date: "bad", score: 50 }));
  const actions = plan.timeline.map(e => e.action);
  assert(actions.includes("writeback_readiness"));
  assert(actions.includes("writeback_prescription"));
});

t("回写：负荷窗口提取实际区间与 ACWR", () => {
  const plan = PL.buildPlan({ start_date: "2026-03-09", weeks: 4 });
  const sessions = [];
  for (let i = 0; i < 28; i++) {
    const d = new Date(2026, 1, 9 + i);
    sessions.push({
      date: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"),
      rpe: 6, minutes: 50, avg_hr: 135, rest_hr: 55, max_hr: 196, sex: "m",
    });
  }
  const analysis = AN.analyzeLog({ sessions, profile: {}, plan, as_of: "2026-03-22" });
  const rec = PL.writeLoadWindow(plan, analysis);
  assert(rec.acwr != null);
  assert(rec.date_from <= "2026-03-09");
});

/* ---------- 协作计划：分析管道接入 ---------- */
t("管道：无计划时向后兼容（无 is_projected 影响既有结论）", () => {
  const r = AN.analyzeLog({ sessions: [], morning: [], profile: { sleep_need: 7.5 } });
  assert.strictEqual(r.today.acwr, null);
  assert.strictEqual(r.days.length, 0);
});

t("管道：传入计划后时间轴延伸至计划结束，未来日标记投影", () => {
  const plan = PL.buildPlan({ start_date: "2026-03-09", weeks: 2 });
  const analysis = AN.analyzeLog({ sessions: [], morning: [], profile: {}, plan, as_of: "2026-03-08" });
  assert.strictEqual(analysis.days.length, 14);
  assert(analysis.days.every(d => d.is_projected));
  assert.strictEqual(analysis.days[0].planned_load, plan.schedule[0].target_load);
  assert.strictEqual(analysis.days[0].score, null);
  assert(analysis.projection.planned_remaining > 0);
});

t("管道：执行中当日处方附加计划课程；高风险自动降级", () => {
  const plan = PL.buildPlan({ start_date: "2026-03-09", weeks: 4, base_load: 500 });
  /* 2/2-3/6 慢性低负荷 + 3/4~3/6 与 3/9 骤升，周一 ACWR 进入危险区间 */
  const sessions = [];
  for (let i = 0; i < 36; i++) {
    const t = new Date(2026, 1, 2 + i);
    if (t.getDay() === 0 || t.getDay() === 6) continue;
    const date = t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
    const hi = (date >= "2026-03-04" && date <= "2026-03-06") || date === "2026-03-09";
    const load = hi ? 1700 : 300;
    sessions.push({ date, rpe: load / 60, minutes: 60, avg_hr: 135, rest_hr: 55, max_hr: 196, sex: "m" });
  }
  const analysis = AN.analyzeLog({ sessions, profile: {}, plan, as_of: "2026-03-09" });
  assert.strictEqual(analysis.today.date, "2026-03-09");
  assert(analysis.today.acwr > 1.5);
  assert(analysis.prescription.planned);
  assert.strictEqual(analysis.prescription.plan_status, "adjusted");
  assert(analysis.prescription.suggested_load < analysis.prescription.planned.planned_load);
});

t("管道：计划休息日处方负荷归零", () => {
  const plan = PL.buildPlan({ start_date: "2026-03-09", weeks: 4 });
  const analysis = AN.analyzeLog({ sessions: [], morning: [], profile: {}, plan, as_of: "2026-03-15" });
  assert.strictEqual(analysis.prescription.plan_status, "rest_day");
  assert.strictEqual(analysis.prescription.suggested_load, 0);
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
