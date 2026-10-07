"use strict";
/* 教练训练计划协作：
   - 角色：coach 制定周期计划，athlete 确认，rehab 在高风险时复核
   - 状态机：draft 草稿 → pending 待确认 → active 执行 → paused 暂停 → archived 归档
   - 高风险计划（当前 ACWR 偏高/危险、准备度过低、周增幅超 10%）须康复师复核通过后方可执行
   - 执行期回写每日负荷分析、准备度与当日处方，统计覆盖率与依从率 */

const P = require("./prescribe");
const M = require("./models");
const { WEEK_SHAPE } = require("./athlete");
const { fmtLocal, parseIso } = require("./date");

const ROLES = ["coach", "athlete", "rehab"];
const ROLE_LABEL = { coach: "教练", athlete: "运动员", rehab: "康复师" };

const PLAN_STATUS = {
  draft:    { key: "draft",    label: "草稿",   color: "#9aa5a0" },
  pending:  { key: "pending",  label: "待确认", color: "#d98e2b" },
  active:   { key: "active",   label: "执行中", color: "#2e8b57" },
  paused:   { key: "paused",   label: "已暂停", color: "#5b8db8" },
  archived: { key: "archived", label: "已归档", color: "#6b7a85" },
};

/* 状态流转表；review 不直接改变状态（approved 留在待确认，rejected 退回草稿） */
const TRANSITIONS = {
  submit:  { from: ["draft"],                                to: "pending",  role: ["coach"] },
  confirm: { from: ["pending"],                              to: "active",   role: ["athlete"] },
  revise:  { from: ["pending"],                              to: "draft",    role: ["athlete", "coach"] },
  review:  { from: ["pending"],                              to: null,       role: ["rehab"] },
  pause:   { from: ["active"],                               to: "paused",   role: ["coach", "athlete"] },
  resume:  { from: ["paused"],                               to: "active",   role: ["coach", "athlete"] },
  archive: { from: ["draft", "pending", "active", "paused"], to: "archived", role: ["coach"] },
};

function createStore() {
  return { plans: new Map(), seq: 0 };
}

function now() {
  return new Date().toISOString();
}

function clampNum(x, lo, hi, dflt) {
  const v = Number(x);
  if (!isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, v));
}

/* 周目标序列：四周递进-减载块，块间基准上移 4%（与合成器一致） */
function planTargets(base, weeks, opts = {}) {
  const targets = [];
  let maxProg = 0;
  for (let w = 0; w < weeks; w++) {
    const block = Math.floor(w / 4);
    const per = P.periodizeWeeks(base * (1 + 0.04 * block), opts);
    const wk = per.weeks[w % 4];
    targets.push({ week: w + 1, target: wk.target, deload: wk.deload, block: block + 1 });
    maxProg = Math.max(maxProg, per.max_progression_pct);
  }
  return { targets, maxProg };
}

/* 日强度区间：按周负荷占比划分（大量日低强度长距离，小量日恢复/节奏） */
function zoneFor(frac) {
  if (frac <= 0) return { key: "rest", label: "休息" };
  if (frac < 0.12) return { key: "z1", label: P.ZONES.z1.label };
  if (frac < 0.2) return { key: "z3", label: P.ZONES.z3.label };
  return { key: "z2", label: P.ZONES.z2.label };
}

/* 逐日日程：周目标 × 一周分布占比，周日休息 */
function buildSchedule(start, targets) {
  const days = [];
  const first = parseIso(start);
  targets.forEach((wk, w) => {
    WEEK_SHAPE.forEach((frac, d) => {
      const dt = new Date(first);
      dt.setDate(dt.getDate() + w * 7 + d);
      const zone = zoneFor(frac);
      days.push({
        date: fmtLocal(dt),
        week: wk.week,
        planned_load: Math.round(wk.target * frac),
        zone: zone.key,
        zone_label: zone.label,
        actual_load: null,
        acwr: null,
        readiness: null,
        readiness_label: null,
        prescription: null,
        done: false,
      });
    });
  });
  return days;
}

/* 风险评估：创建时的负荷状态快照 + 计划本身的周增幅 */
function assessRisk(plan, context = {}) {
  const reasons = [];
  const band = M.acwrBand(context.acwr != null ? Number(context.acwr) : null);
  if (band.key === "caution") reasons.push("当前 ACWR 偏高（" + Number(context.acwr).toFixed(2) + "）");
  if (band.key === "danger") reasons.push("当前 ACWR 处于危险区（" + Number(context.acwr).toFixed(2) + "）");
  if (context.readiness != null && Number(context.readiness) < 40) {
    reasons.push("运动员准备度过低（" + Math.round(Number(context.readiness)) + " / 100）");
  }
  if (plan.max_progression_pct > 10) {
    reasons.push("周负荷增幅 " + plan.max_progression_pct + "% 超过 10% 安全阈值");
  }
  return { high: reasons.length > 0, reasons };
}

/* 教练创建周期计划（草稿） */
function createPlan(store, opts = {}) {
  const coach = String(opts.coach || "").trim();
  const athlete = String(opts.athlete || "").trim();
  if (!coach) throw new Error("缺少教练姓名");
  if (!athlete) throw new Error("缺少运动员姓名");
  const start = /^\d{4}-\d{2}-\d{2}$/.test(opts.start || "") ? opts.start : fmtLocal(new Date());
  const weeks = Math.round(clampNum(opts.weeks, 1, 16, 4));
  const base = clampNum(opts.base_load, 200, 1200, 500);
  const perOpts = {};
  if (opts.increment != null) perOpts.increment = clampNum(opts.increment, 0, 0.2, 0.08);
  if (opts.deload != null) perOpts.deload = clampNum(opts.deload, 0.3, 1, 0.6);

  const { targets, maxProg } = planTargets(base, weeks, perOpts);
  store.seq += 1;
  const plan = {
    id: "PL" + String(store.seq).padStart(4, "0"),
    title: String(opts.title || "").trim() || (athlete + " 的 " + weeks + " 周周期计划"),
    coach,
    athlete,
    status: "draft",
    start,
    weeks,
    base_load: base,
    weekly_targets: targets,
    max_progression_pct: maxProg,
    days: buildSchedule(start, targets),
    context: {
      acwr: opts.context && opts.context.acwr != null ? Number(opts.context.acwr) : null,
      readiness: opts.context && opts.context.readiness != null ? Number(opts.context.readiness) : null,
    },
    risk: null,
    review: null,
    writeback: null,
    history: [],
    created_at: now(),
    updated_at: now(),
  };
  plan.risk = assessRisk(plan, plan.context);
  plan.history.push({ at: plan.created_at, action: "create", by: { role: "coach", name: coach }, note: "创建计划（草稿）", from: null, to: "draft" });
  store.plans.set(plan.id, plan);
  return plan;
}

/* 状态流转：校验角色权限与当前状态，高风险计划确认前须复核通过 */
function transition(store, id, action, actor = {}, body = {}) {
  const plan = store.plans.get(id);
  if (!plan) throw new Error("计划不存在");
  const tr = TRANSITIONS[action];
  if (!tr) throw new Error("未知操作：" + action);
  const role = actor.role;
  if (!ROLES.includes(role)) throw new Error("未知角色：" + role);
  if (!tr.role.includes(role)) throw new Error("当前角色（" + (ROLE_LABEL[role] || role) + "）无权执行该操作");
  if (!tr.from.includes(plan.status)) {
    throw new Error("当前状态（" + PLAN_STATUS[plan.status].label + "）不允许该操作");
  }
  const name = String(actor.name || "").trim() || ROLE_LABEL[role];
  const note = String(body.note || "").trim();

  if (action === "review") {
    if (!plan.risk.high) throw new Error("该计划非高风险，无需康复师复核");
    const decision = body.decision === "approved" ? "approved" : body.decision === "rejected" ? "rejected" : null;
    if (!decision) throw new Error("复核结论须为 approved 或 rejected");
    plan.review = { decision, by: name, at: now(), note };
    if (decision === "rejected") {
      plan.history.push({ at: plan.review.at, action, by: { role, name }, note: note || "复核退回", from: plan.status, to: "draft" });
      plan.status = "draft";
    } else {
      plan.history.push({ at: plan.review.at, action, by: { role, name }, note: note || "复核通过", from: plan.status, to: plan.status });
    }
    plan.updated_at = now();
    return plan;
  }

  if (action === "confirm" && plan.risk.high && (!plan.review || plan.review.decision !== "approved")) {
    throw new Error("高风险计划须康复师复核通过后方可确认执行");
  }

  const from = plan.status;
  plan.status = tr.to;
  plan.updated_at = now();
  plan.history.push({ at: plan.updated_at, action, by: { role, name }, note, from, to: tr.to });
  return plan;
}

/* 回写：将分析结果（逐日负荷 / ACWR / 准备度）写入计划对应日期，
   并按当日状态推导每日处方；统计覆盖率与依从率（实际 / 计划 在 0.8-1.2 内视为达标） */
function writeBack(store, id, analysisDays) {
  const plan = store.plans.get(id);
  if (!plan) throw new Error("计划不存在");
  if (!["active", "paused"].includes(plan.status)) {
    throw new Error("仅执行中或暂停中的计划可回写分析数据");
  }
  const byDate = new Map((analysisDays || []).map(d => [d.date, d]));
  const weekAccum = new Map(); // 计划周内当日之前的实际负荷累计
  let covered = 0, adherent = 0, plannedTotal = 0, actualTotal = 0;
  for (const day of plan.days) {
    const acc = weekAccum.get(day.week) || 0;
    const a = byDate.get(day.date);
    if (!a) continue;
    const load = a.load != null ? Number(a.load) : 0;
    const readiness = a.score != null ? Number(a.score) : (a.readiness != null ? Number(a.readiness) : null);
    day.actual_load = Math.round(load);
    day.acwr = a.acwr != null ? Number(a.acwr) : null;
    day.readiness = readiness;
    day.readiness_label = a.label && a.label.label ? a.label.label : (typeof a.label === "string" ? a.label : null);
    day.prescription = P.prescribe({
      date: day.date,
      acwr: day.acwr,
      chronic: a.chronic != null ? Number(a.chronic) : null,
      week_accumulated: acc,
      readiness,
      readinessLabel: day.readiness_label,
    });
    day.done = true;
    covered++;
    plannedTotal += day.planned_load;
    actualTotal += day.actual_load;
    const hit = day.planned_load === 0
      ? day.actual_load === 0
      : day.actual_load >= day.planned_load * 0.8 && day.actual_load <= day.planned_load * 1.2;
    if (hit) adherent++;
    weekAccum.set(day.week, acc + day.actual_load);
  }
  plan.writeback = {
    at: now(),
    covered_days: covered,
    total_days: plan.days.length,
    completion_pct: plan.days.length ? Math.round((covered / plan.days.length) * 100) : 0,
    planned_load: Math.round(plannedTotal),
    actual_load: Math.round(actualTotal),
    adherence_pct: covered ? Math.round((adherent / covered) * 100) : null,
  };
  plan.updated_at = plan.writeback.at;
  return plan;
}

/* 列表（按角色过滤，摘要不含逐日明细） */
function listPlans(store, filter = {}) {
  const out = [];
  for (const plan of store.plans.values()) {
    if (filter.role === "coach" && filter.name && plan.coach !== filter.name) continue;
    if (filter.role === "athlete" && filter.name && plan.athlete !== filter.name) continue;
    out.push({
      id: plan.id,
      title: plan.title,
      coach: plan.coach,
      athlete: plan.athlete,
      status: plan.status,
      status_label: PLAN_STATUS[plan.status].label,
      start: plan.start,
      weeks: plan.weeks,
      risk: plan.risk,
      review: plan.review ? plan.review.decision : null,
      writeback: plan.writeback,
      created_at: plan.created_at,
      updated_at: plan.updated_at,
    });
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/* 详情：附状态标签 */
function detail(plan) {
  return Object.assign({}, plan, { status_label: PLAN_STATUS[plan.status].label });
}

module.exports = {
  ROLES,
  ROLE_LABEL,
  PLAN_STATUS,
  TRANSITIONS,
  createStore,
  createPlan,
  transition,
  writeBack,
  listPlans,
  detail,
  assessRisk,
  planTargets,
  buildSchedule,
  zoneFor,
};
