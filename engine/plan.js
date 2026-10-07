"use strict";
/* 教练训练计划协作领域模型：
   - 角色：教练 coach / 运动员 athlete / 康复师 therapist
   - 状态流转：草稿 draft → 待确认 pending_confirmation → 执行 executing
               ↔ 暂停 paused → 归档 archived（终态）
   - 高风险时康复师强制复核（approve / request_changes）后方可执行
   - 周期计划按四周块生成（递进 + 减载），展开为每日处方
   - 负荷投影：实际历史 + 未来计划 → 投影 ACWR / 体能-疲劳
   - 回写：准备度快照、实际负荷窗口、每日处方留痕 */

const crypto = require("crypto");
const M = require("./models");
const P = require("./prescribe");
const A = require("./athlete");
const { fmtLocal, parseIso, daysInRange } = require("./date");

/* ---------- 常量 ---------- */

const STATUS = {
  draft: { key: "draft", label: "草稿", color: "#9aa5a0" },
  pending_confirmation: { key: "pending_confirmation", label: "待确认", color: "#d98e2b" },
  executing: { key: "executing", label: "执行中", color: "#2e8b57" },
  paused: { key: "paused", label: "已暂停", color: "#5b8db8" },
  archived: { key: "archived", label: "已归档", color: "#7a8a93" },
};

const ROLES = {
  coach: { key: "coach", label: "教练" },
  athlete: { key: "athlete", label: "运动员" },
  therapist: { key: "therapist", label: "康复师" },
};

/* 风险阈值 */
const RISK = {
  PROGRESSION_WARN: 0.10,
  PROGRESSION_HIGH: 0.20,
  ACWR_WARN: 1.3,
  ACWR_HIGH: 1.5,
  READINESS_WARN: 60,
  READINESS_HIGH: 40,
  FIRST_WEEK_WARN: 1.3,
  FIRST_WEEK_HIGH: 1.5,
  SINGLE_DAY_WARN: 2.0, // 单日计划负荷 / 慢性日均
};

/* 一周训练分布（周一至周日，周日休息）与默认 RPE 模板 */
const DAY_SPORTS = ["run", "ride", "swim", "run", "strength", "run", "rest"];
const DAY_RPE = [5, 6, 4, 6, 7, 5, 0];

/* 动作 → 合法源状态 / 角色 */
const MACHINE = {
  submit: { from: ["draft"], roles: ["coach"], to: "pending_confirmation" },
  confirm: { from: ["pending_confirmation"], roles: ["athlete"], to: "executing" },
  pause: { from: ["executing"], roles: ["coach", "athlete"], to: "paused" },
  resume: { from: ["paused"], roles: ["coach", "athlete"], to: "executing" },
  revise: { from: ["pending_confirmation", "paused"], roles: ["coach"], to: "draft" },
  archive: { from: ["draft", "executing", "paused"], roles: ["coach"], to: "archived" },
};

const ACTION_LABEL = {
  create: "创建计划",
  edit: "修订计划",
  submit: "提交确认",
  review_approve: "康复师复核通过",
  review_changes: "康复师退回修改",
  confirm: "运动员确认",
  pause: "暂停计划",
  resume: "恢复执行",
  revise: "教练撤回修订",
  archive: "归档计划",
  writeback_readiness: "回写准备度",
  writeback_load: "回写负荷分析",
  writeback_prescription: "回写每日处方",
};

class PlanError extends Error {
  constructor(message, code = "invalid_action") {
    super(message);
    this.code = code;
  }
}

/* ---------- 工具 ---------- */

function nowISO() {
  return new Date().toISOString();
}

function newId() {
  return "p_" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function validDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(parseIso(s).getTime());
}

function addDays(iso, n) {
  const d = parseIso(iso);
  d.setDate(d.getDate() + n);
  return fmtLocal(d);
}

function rpeZone(rpe) {
  if (rpe < 3) return P.ZONES.z1;
  if (rpe < 4.5) return P.ZONES.z2;
  if (rpe < 6) return P.ZONES.z3;
  if (rpe < 8) return P.ZONES.z4;
  return P.ZONES.z5;
}

/* ---------- 周期与日程生成 ---------- */

/* 周目标：四周块 [1, 1+inc, 1+2inc, (1+2inc)×deload]，块间基准 +4% */
function weeklyTargets(baseLoad, weeks, increment, deload) {
  const out = [];
  for (let w = 0; w < weeks; w++) {
    const block = Math.floor(w / 4);
    const phase = w % 4;
    const blockBase = baseLoad * (1 + 0.04 * block);
    const f = phase === 3 ? (1 + 2 * increment) * deload : 1 + phase * increment;
    out.push({ week: w + 1, target: Math.round(blockBase * f), deload: phase === 3 });
  }
  return out;
}

function sessionOf(sport, minutes, rpe) {
  const sp = A.SPORT_POOL[sport] ? sport : "run";
  const m = clamp(Math.round(minutes), 15, 240);
  const r = clamp(Math.round(rpe * 2) / 2, 1, 10);
  const zone = rpeZone(r);
  return {
    sport: sp,
    sport_label: A.SPORT_POOL[sp].label,
    minutes: m,
    rpe: r,
    zone: zone.key,
    zone_label: zone.label,
    planned_load: Math.round(m * r),
  };
}

/* 默认日课程：周六为两节（有氧 + 高强度），周日休息 */
function defaultSessions(dayIdx, dayLoad) {
  if (dayIdx === 6 || dayLoad <= 0) return [];
  if (dayIdx === 5) {
    const a = dayLoad * 0.6;
    const b = dayLoad * 0.4;
    return [
      sessionOf("run", a / 5, 5),
      sessionOf("run", b / 8, 8),
    ];
  }
  return [sessionOf(DAY_SPORTS[dayIdx], dayLoad / DAY_RPE[dayIdx], DAY_RPE[dayIdx])];
}

/* day_overrides: { "YYYY-MM-DD": { rest: true } | { sessions: [{sport, minutes, rpe}] } } */
function buildSchedule(targets, startDate, overrides = {}) {
  const out = [];
  targets.forEach((wt, w) => {
    for (let d = 0; d < 7; d++) {
      const date = addDays(startDate, w * 7 + d);
      const targetLoad = Math.round(wt.target * A.WEEK_SHAPE[d]);
      let sessions = defaultSessions(d, targetLoad);
      const ov = overrides[date];
      if (ov) {
        if (ov.rest === true) sessions = [];
        else if (Array.isArray(ov.sessions)) sessions = ov.sessions.map(s => sessionOf(s.sport, s.minutes, s.rpe));
      }
      const actualLoad = sessions.reduce((s, x) => s + x.planned_load, 0);
      out.push({
        date,
        week: w + 1,
        day: d + 1,
        is_rest: sessions.length === 0,
        target_load: actualLoad,
        sessions,
      });
    }
  });
  return out;
}

function normalizeInput(input = {}) {
  const weeks = clamp(parseInt(input.weeks, 10) || 4, 1, 16);
  return {
    title: typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 80) : "周期训练计划",
    athlete_name: String(input.athlete_name || "运动员").slice(0, 40),
    coach_name: String(input.coach_name || "教练").slice(0, 40),
    sport: A.SPORT_POOL[input.sport] ? input.sport : "run",
    start_date: validDate(input.start_date) ? input.start_date : fmtLocal(new Date()),
    weeks,
    base_load: clamp(Number(input.base_load) || 500, 100, 2000),
    increment: clamp(Number(input.increment != null ? input.increment : 0.08), -0.2, 0.3),
    deload: clamp(Number(input.deload != null ? input.deload : 0.6), 0.3, 0.9),
    day_overrides: input.day_overrides && typeof input.day_overrides === "object" ? input.day_overrides : {},
    note: typeof input.note === "string" ? input.note.slice(0, 500) : "",
  };
}

function buildPlan(input = {}, opts = {}) {
  const cfg = normalizeInput(input);
  const targets = weeklyTargets(cfg.base_load, cfg.weeks, cfg.increment, cfg.deload);
  const schedule = buildSchedule(targets, cfg.start_date, cfg.day_overrides);
  const weeksMeta = targets.map((t, i) => ({
    ...t,
    date_start: addDays(cfg.start_date, i * 7),
    date_end: addDays(cfg.start_date, i * 7 + 6),
  }));
  const ts = opts.now || nowISO();
  return {
    id: opts.id || newId(),
    title: cfg.title,
    athlete_name: cfg.athlete_name,
    coach_name: cfg.coach_name,
    sport: cfg.sport,
    sport_label: A.SPORT_POOL[cfg.sport].label,
    start_date: cfg.start_date,
    end_date: addDays(cfg.start_date, cfg.weeks * 7 - 1),
    weeks: cfg.weeks,
    base_load: cfg.base_load,
    increment: cfg.increment,
    deload: cfg.deload,
    note: cfg.note,
    status: "draft",
    weekly_targets: weeksMeta,
    schedule,
    risk: null,
    review: null,
    confirmation: null,
    writeback: { readiness_snapshots: [], load_windows: [], daily_prescriptions: [] },
    timeline: [
      { at: ts, actor: cfg.coach_name, role: "coach", action: "create", from: null, to: "draft", note: cfg.note || "" },
    ],
    created_at: ts,
    updated_at: ts,
    version: 1,
  };
}

/* 教练在草稿态修订：保留 id / 时间线 / 回写留痕，重建周期结构 */
function rebuildPlan(plan, patch, opts = {}) {
  if (plan.status !== "draft") throw new PlanError("仅草稿状态可修订，请先撤回", "not_editable");
  const merged = {
    title: plan.title, athlete_name: plan.athlete_name, coach_name: plan.coach_name,
    sport: plan.sport, start_date: plan.start_date, weeks: plan.weeks,
    base_load: plan.base_load, increment: plan.increment, deload: plan.deload, note: plan.note,
    ...patch,
  };
  const cfg = normalizeInput(merged);
  const targets = weeklyTargets(cfg.base_load, cfg.weeks, cfg.increment, cfg.deload);
  const schedule = buildSchedule(targets, cfg.start_date, cfg.day_overrides || {});
  const weeksMeta = targets.map((t, i) => ({
    ...t,
    date_start: addDays(cfg.start_date, i * 7),
    date_end: addDays(cfg.start_date, i * 7 + 6),
  }));
  const ts = opts.now || nowISO();
  Object.assign(plan, {
    title: cfg.title,
    athlete_name: cfg.athlete_name,
    coach_name: cfg.coach_name,
    sport: cfg.sport,
    sport_label: A.SPORT_POOL[cfg.sport].label,
    start_date: cfg.start_date,
    end_date: addDays(cfg.start_date, cfg.weeks * 7 - 1),
    weeks: cfg.weeks,
    base_load: cfg.base_load,
    increment: cfg.increment,
    deload: cfg.deload,
    note: cfg.note,
    weekly_targets: weeksMeta,
    schedule,
    risk: null,
    review: null,
    confirmation: null,
    updated_at: ts,
    version: plan.version + 1,
  });
  addTimeline(plan, { at: ts, actor: cfg.coach_name, role: "coach", action: "edit", from: "draft", to: "draft", note: patch.note || "" });
  return plan;
}

/* ---------- 时间线 ---------- */

function addTimeline(plan, entry) {
  plan.timeline.push({ at: nowISO(), note: "", ...entry });
  plan.updated_at = entry.at || nowISO();
}

/* ---------- 高风险评估 ---------- */

function factor(code, level, message, data = {}) {
  return { code, level, message, data };
}

function assessRisk(plan, ctx = {}) {
  const factors = [];

  /* 1. 相邻非减载周负荷增幅 */
  let maxProgression = 0;
  plan.weekly_targets.forEach((w, i) => {
    if (i === 0) return;
    const prev = plan.weekly_targets[i - 1];
    if (w.deload || prev.deload || prev.target <= 0) return;
    const pct = (w.target - prev.target) / prev.target;
    if (pct > maxProgression) maxProgression = pct;
  });
  if (maxProgression > RISK.PROGRESSION_HIGH) {
    factors.push(factor("progression", "high", `相邻非减载周最大增幅 ${(maxProgression * 100).toFixed(0)}%，超过 20% 高风险阈值`, { max_pct: Math.round(maxProgression * 1000) / 10 }));
  } else if (maxProgression > RISK.PROGRESSION_WARN) {
    factors.push(factor("progression", "warn", `相邻非减载周最大增幅 ${(maxProgression * 100).toFixed(0)}%，高于 10% 经验阈值`, { max_pct: Math.round(maxProgression * 1000) / 10 }));
  }

  /* 2. 长周期缺减载 */
  if (plan.weeks >= 4 && !plan.weekly_targets.some(w => w.deload)) {
    factors.push(factor("missing_deload", "high", `计划长达 ${plan.weeks} 周但未安排减载周，疲劳难以释放`));
  }

  /* 3. 首周负荷相对慢性周负荷的冲击 */
  if (ctx.chronic > 0) {
    const ratio = plan.weekly_targets[0].target / (ctx.chronic * 7);
    if (ratio > RISK.FIRST_WEEK_HIGH) {
      factors.push(factor("first_week_load", "high", `首周目标 ${plan.weekly_targets[0].target} 为慢性周负荷的 ${ratio.toFixed(2)} 倍，起点过激`, { ratio: Math.round(ratio * 100) / 100 }));
    } else if (ratio > RISK.FIRST_WEEK_WARN) {
      factors.push(factor("first_week_load", "warn", `首周目标高于慢性周负荷 ${((ratio - 1) * 100).toFixed(0)}%`, { ratio: Math.round(ratio * 100) / 100 }));
    }

    /* 4. 单日峰值 */
    const peakDay = plan.schedule.reduce((mx, d) => Math.max(mx, d.target_load), 0);
    const dayRatio = peakDay / ctx.chronic;
    if (dayRatio > RISK.SINGLE_DAY_WARN) {
      factors.push(factor("single_day_peak", "warn", `计划单日峰值负荷 ${peakDay} 达慢性日均的 ${dayRatio.toFixed(1)} 倍`, { peak: peakDay, ratio: Math.round(dayRatio * 10) / 10 }));
    }
  }

  /* 5. 当前 ACWR */
  if (ctx.acwr != null) {
    if (ctx.acwr >= RISK.ACWR_HIGH) factors.push(factor("current_acwr", "high", `当前 ACWR ${ctx.acwr} 已处危险区间（≥1.5）`));
    else if (ctx.acwr >= RISK.ACWR_WARN) factors.push(factor("current_acwr", "warn", `当前 ACWR ${ctx.acwr} 处谨慎区间（≥1.3）`));
  }

  /* 6. 当前准备度 */
  if (ctx.readiness != null) {
    if (ctx.readiness < RISK.READINESS_HIGH) factors.push(factor("current_readiness", "high", `当前准备度 ${ctx.readiness} 过低（<40），不建议加量`));
    else if (ctx.readiness < RISK.READINESS_WARN) factors.push(factor("current_readiness", "warn", `当前准备度 ${ctx.readiness} 偏低（<60）`));
  }

  /* 7. 投影 ACWR 峰值 */
  if (ctx.peak_acwr != null) {
    if (ctx.peak_acwr >= RISK.ACWR_HIGH) factors.push(factor("projected_acwr", "high", `按计划执行投影 ACWR 峰值 ${ctx.peak_acwr} 将进入危险区间`, { peak: ctx.peak_acwr, peak_date: ctx.peak_date || null }));
    else if (ctx.peak_acwr >= RISK.ACWR_WARN) factors.push(factor("projected_acwr", "warn", `按计划执行投影 ACWR 峰值 ${ctx.peak_acwr} 进入谨慎区间`, { peak: ctx.peak_acwr, peak_date: ctx.peak_date || null }));
  }

  const level = factors.some(f => f.level === "high") ? "high" : factors.some(f => f.level === "warn") ? "warn" : "low";
  return {
    level,
    label: level === "high" ? "高风险" : level === "warn" ? "需关注" : "风险可控",
    review_required: level === "high",
    factors,
    max_progression_pct: Math.round(maxProgression * 1000) / 10,
    peak_acwr: ctx.peak_acwr != null ? ctx.peak_acwr : null,
    evaluated_at: ctx.now || nowISO(),
  };
}

/* ---------- 负荷投影 ---------- */

function plannedDailyMap(plan) {
  const m = new Map();
  for (const d of plan.schedule) m.set(d.date, d.target_load);
  return m;
}

/* 实际历史 + 未来计划拼接：计划期内 asOf 之前取实际（缺训为 0），之后取计划 */
function projectLoads(sessions, plan, asOf) {
  const actual = M.dailyLoads(sessions || [], "srpe");
  const actualMap = new Map(actual.map(d => [d.date, d.load]));
  const planned = plannedDailyMap(plan);
  let from = plan.start_date;
  let to = plan.end_date;
  if (actual.length) {
    if (actual[0].date < from) from = actual[0].date;
    if (actual[actual.length - 1].date > to) to = actual[actual.length - 1].date;
  }
  const daily = daysInRange(from, to).map(date => {
    const inPlan = planned.has(date);
    let load;
    let kind;
    if (inPlan && date > asOf) {
      load = planned.get(date);
      kind = "planned";
    } else if (actualMap.has(date)) {
      load = actualMap.get(date);
      kind = "actual";
    } else {
      load = 0;
      kind = inPlan ? "actual" : "rest";
    }
    return { date, load, kind, planned_load: inPlan ? planned.get(date) : null };
  });
  const acwr = M.acwrSeries(daily);
  const ff = M.fitnessFatigue(daily);
  let peak = null;
  let peakDate = null;
  for (const r of acwr) {
    if (r.date > asOf && planned.has(r.date) && r.acwr != null && (peak === null || r.acwr > peak)) {
      peak = r.acwr;
      peakDate = r.date;
    }
  }
  return { daily, acwr, ff, peak_acwr: peak, peak_date: peakDate };
}

/* ---------- 执行风险（执行中的当日复核） ---------- */

function executionRisk(plan, ctx) {
  const factors = [];
  const item = plan.schedule.find(d => d.date === ctx.date);
  let weekRatio = null;
  let weekTarget = null;
  if (item) {
    weekTarget = plan.weekly_targets[item.week - 1].target;
    const expectedFrac = A.WEEK_SHAPE.slice(0, item.day).reduce((s, f) => s + f, 0) / A.WEEK_SHAPE.reduce((s, f) => s + f, 0);
    const expected = Math.max(1, weekTarget * expectedFrac);
    weekRatio = Math.round((ctx.week_accumulated / expected) * 100) / 100;
    if (weekRatio > 1.15) {
      factors.push(factor("week_ahead", "warn", `本周已完成 ${ctx.week_accumulated}，进度超前（应为 ${Math.round(expected)}），防止周内过载`, { ratio: weekRatio }));
    } else if (weekRatio < 0.6) {
      factors.push(factor("week_behind", "info", `本周累计 ${ctx.week_accumulated} 低于预期进度 ${Math.round(expected)}，注意后续补量节奏`, { ratio: weekRatio }));
    }
  }
  if (ctx.acwr != null && ctx.acwr >= RISK.ACWR_HIGH) {
    factors.push(factor("current_acwr", "high", `当前 ACWR ${ctx.acwr} 处危险区间，今日计划应降级为恢复课`));
  }
  if (ctx.readiness != null && ctx.readiness < RISK.READINESS_HIGH) {
    factors.push(factor("current_readiness", "high", `准备度 ${ctx.readiness} 过低，今日计划应降级为恢复课`));
  } else if (ctx.readiness != null && ctx.readiness < RISK.READINESS_WARN) {
    factors.push(factor("current_readiness", "warn", `准备度 ${ctx.readiness} 偏低，谨慎完成今日内容`));
  }
  const level = factors.some(f => f.level === "high") ? "high" : factors.some(f => f.level === "warn") ? "warn" : "low";
  return {
    level,
    factors,
    plan_status: level === "high" ? "adjusted" : level === "warn" ? "caution" : "planned",
    week_target: weekTarget,
    week_progress_ratio: weekRatio,
    is_rest_day: item ? item.is_rest : null,
    evaluated_at: ctx.now || nowISO(),
  };
}

/* ---------- 状态机 ---------- */

function assertRole(rule, role) {
  if (!rule.roles.includes(role)) {
    throw new PlanError(`该动作仅允许 ${rule.roles.map(r => ROLES[r].label).join(" / ")} 执行`, "forbidden");
  }
}

function transition(plan, action, params = {}) {
  const rule = MACHINE[action];
  if (!rule) throw new PlanError("未知动作：" + action);
  if (!rule.from.includes(plan.status)) {
    throw new PlanError(`当前状态「${STATUS[plan.status].label}」不允许执行「${ACTION_LABEL[action] || action}」`);
  }
  assertRole(rule, params.role);

  const ts = params.now || nowISO();
  const from = plan.status;

  if (action === "submit") {
    /* 提交即评估；高风险自动挂起康复师复核 */
    const risk = params.risk || assessRisk(plan, params.risk_ctx || {});
    plan.risk = risk;
    if (risk.review_required) {
      plan.review = { required: true, status: "pending", therapist: null, note: "", reviewed_at: null };
    } else {
      plan.review = null;
    }
    plan.confirmation = null;
  }

  if (action === "confirm") {
    if (plan.review && plan.review.required && plan.review.status !== "approved") {
      throw new PlanError("该计划存在高风险因素，须等待康复师复核通过后方可确认", "review_required");
    }
    plan.confirmation = { athlete: params.actor || plan.athlete_name, confirmed_at: ts, note: params.note || "" };
  }

  let to = rule.to;
  if (action === "resume" && params.risk && params.risk.review_required) {
    /* 恢复时重新评估仍为高风险：退回待确认，重新走康复师复核 */
    to = "pending_confirmation";
    plan.risk = params.risk;
    plan.review = { required: true, status: "pending", therapist: null, note: "", reviewed_at: null };
  }

  plan.status = to;
  addTimeline(plan, {
    at: ts, actor: params.actor || "", role: params.role, action,
    from, to, note: params.note || "",
  });
  return plan;
}

/* 康复师复核：approve 解锁确认；request_changes 退回草稿 */
function review(plan, params = {}) {
  if (params.role !== "therapist") throw new PlanError("仅康复师可复核", "forbidden");
  if (plan.status !== "pending_confirmation") throw new PlanError("仅待确认状态的计划可复核");
  if (!plan.review || !plan.review.required) throw new PlanError("该计划无需康复师复核");
  if (!["approve", "request_changes"].includes(params.decision)) throw new PlanError("复核决定必须为 approve 或 request_changes");
  const ts = params.now || nowISO();

  if (params.decision === "approve") {
    plan.review = { ...plan.review, status: "approved", therapist: params.actor || "康复师", note: params.note || "", reviewed_at: ts };
    addTimeline(plan, { at: ts, actor: params.actor || "康复师", role: "therapist", action: "review_approve", from: "pending_confirmation", to: "pending_confirmation", note: params.note || "" });
  } else {
    plan.review = { ...plan.review, status: "changes_requested", therapist: params.actor || "康复师", note: params.note || "", reviewed_at: ts };
    plan.status = "draft";
    addTimeline(plan, { at: ts, actor: params.actor || "康复师", role: "therapist", action: "review_changes", from: "pending_confirmation", to: "draft", note: params.note || "" });
  }
  return plan;
}

/* ---------- 回写 ---------- */

function upsertByDate(list, entry) {
  const i = list.findIndex(x => x.date === entry.date);
  if (i >= 0) list[i] = { ...list[i], ...entry };
  else list.push(entry);
}

function writeReadiness(plan, entry, meta = {}) {
  if (!validDate(entry.date)) throw new PlanError("回写准备度需要合法日期");
  if (!(entry.score >= 0 && entry.score <= 100)) throw new PlanError("准备度评分须在 0-100");
  const rec = {
    date: entry.date,
    score: Math.round(entry.score),
    label: entry.label || null,
    source: entry.source || "analysis",
    at: meta.now || nowISO(),
  };
  upsertByDate(plan.writeback.readiness_snapshots, rec);
  addTimeline(plan, { at: rec.at, actor: meta.actor || "系统", role: meta.role || "coach", action: "writeback_readiness", from: plan.status, to: plan.status, note: `${rec.date} 准备度 ${rec.score}` });
  return rec;
}

function writeLoadWindow(plan, analysis, meta = {}) {
  const days = analysis.days || [];
  if (!days.length) throw new PlanError("负荷分析结果为空，无法回写");
  const actualDays = days.filter(d => !d.is_projected);
  const rec = {
    date_from: actualDays.length ? actualDays[0].date : days[0].date,
    date_to: actualDays.length ? actualDays[actualDays.length - 1].date : days[days.length - 1].date,
    sessions: analysis.totals ? analysis.totals.sessions : 0,
    actual_load: analysis.totals ? analysis.totals.total_load : actualDays.reduce((s, d) => s + (d.load || 0), 0),
    acwr: analysis.today ? analysis.today.acwr : null,
    band: analysis.today && analysis.today.band ? analysis.today.band.key : null,
    at: meta.now || nowISO(),
  };
  plan.writeback.load_windows.push(rec);
  addTimeline(plan, { at: rec.at, actor: meta.actor || "系统", role: meta.role || "coach", action: "writeback_load", from: plan.status, to: plan.status, note: `窗口 ${rec.date_from}~${rec.date_to} 实际负荷 ${rec.actual_load}` });
  return rec;
}

function writePrescription(plan, prescription, meta = {}) {
  const date = prescription.date || meta.date;
  if (!validDate(date)) throw new PlanError("回写处方需要合法日期");
  const rec = {
    date,
    zone: prescription.intensity ? prescription.intensity.zone.key : null,
    zone_label: prescription.intensity ? prescription.intensity.zone.label : null,
    suggested_load: prescription.suggested_load,
    suggested_range: prescription.suggested_range,
    planned_load: prescription.planned && prescription.planned.planned_load != null ? prescription.planned.planned_load : null,
    plan_status: prescription.plan_status || "planned",
    execution_risk: prescription.execution_risk
      ? { level: prescription.execution_risk.level, factors: prescription.execution_risk.factors }
      : null,
    note: prescription.note || "",
    at: meta.now || nowISO(),
  };
  upsertByDate(plan.writeback.daily_prescriptions, rec);
  addTimeline(plan, { at: rec.at, actor: meta.actor || "系统", role: meta.role || "coach", action: "writeback_prescription", from: plan.status, to: plan.status, note: `${date} 处方（${rec.plan_status}）` });
  return rec;
}

/* 计划摘要（列表用） */
function summary(plan) {
  return {
    id: plan.id,
    title: plan.title,
    athlete_name: plan.athlete_name,
    coach_name: plan.coach_name,
    sport_label: plan.sport_label,
    status: plan.status,
    status_label: STATUS[plan.status].label,
    start_date: plan.start_date,
    end_date: plan.end_date,
    weeks: plan.weeks,
    risk_level: plan.risk ? plan.risk.level : null,
    review_required: !!(plan.review && plan.review.required && plan.review.status === "pending"),
    updated_at: plan.updated_at,
    version: plan.version,
  };
}

module.exports = {
  STATUS,
  ROLES,
  RISK,
  MACHINE,
  ACTION_LABEL,
  PlanError,
  weeklyTargets,
  buildSchedule,
  buildPlan,
  rebuildPlan,
  assessRisk,
  projectLoads,
  executionRisk,
  transition,
  review,
  writeReadiness,
  writeLoadWindow,
  writePrescription,
  addTimeline,
  summary,
  rpeZone,
  validDate,
};
