"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const A = require("./engine/athlete");
const AN = require("./engine/analyzer");
const M = require("./engine/models");
const R = require("./engine/recovery");
const P = require("./engine/prescribe");
const PL = require("./engine/plan");
const Store = require("./store");

const arg = process.argv.find(a => a.startsWith("--port="));
const PORT = arg ? parseInt(arg.slice(7), 10) : parseInt(process.env.PORT || "8075", 10);
const WEB = path.join(__dirname, "web");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => {
      buf += c;
      if (buf.length > 4e6) req.destroy();
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
}

function fail(res, e) {
  const code = e && (e.code === "forbidden") ? 403 : 400;
  json(res, code, { error: e.message, code: e.code || "bad_request" });
}

function sanitizeProfile(p) {
  const out = p || {};
  if (!["m", "f"].includes(out.sex)) out.sex = "m";
  if (!(out.rest_hr >= 40 && out.rest_hr <= 90)) out.rest_hr = 54;
  if (!(out.max_hr >= 160 && out.max_hr <= 220)) out.max_hr = 196;
  if (!(out.sleep_need >= 5 && out.sleep_need <= 11)) out.sleep_need = 7.5;
  if (!(out.hrv_base >= 30 && out.hrv_base <= 130)) out.hrv_base = 72;
  if (!(out.base_load >= 200 && out.base_load <= 1200)) out.base_load = 500;
  return out;
}

/* 由历史日志构建高风险评估上下文（当前 ACWR / 慢性 / 准备度 + 投影峰值） */
function riskContext(plan, body) {
  const ctx = {};
  if (Array.isArray(body.sessions) && body.sessions.length) {
    const analysis = AN.analyzeLog({
      sessions: body.sessions,
      morning: Array.isArray(body.morning) ? body.morning : [],
      profile: sanitizeProfile(body.profile),
      plan,
      as_of: body.as_of || null,
    });
    ctx.acwr = analysis.today.acwr;
    ctx.chronic = analysis.today.chronic;
    ctx.readiness = analysis.today.readiness;
    if (analysis.projection) {
      ctx.peak_acwr = analysis.projection.peak_acwr;
      ctx.peak_date = analysis.projection.peak_date;
    }
  }
  if (body.risk_ctx && typeof body.risk_ctx === "object") Object.assign(ctx, body.risk_ctx);
  return ctx;
}

function planAnalysis(plan, body) {
  return AN.analyzeLog({
    sessions: Array.isArray(body.sessions) ? body.sessions : [],
    morning: Array.isArray(body.morning) ? body.morning : [],
    profile: sanitizeProfile(body.profile),
    plan,
    as_of: body.as_of || null,
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (p === "/api/system" && req.method === "GET") {
      return json(res, 200, { name: "athlete-load", version: 1, title: "个人运动训练负荷与恢复管理系统" });
    }
    if (p === "/api/meta" && req.method === "GET") {
      return json(res, 200, {
        zones: P.ZONES,
        readiness_weights: R.READINESS_WEIGHTS,
        tau: { fitness: M.TAU_FIT, fatigue: M.TAU_FAT },
        sex_k: M.SEX_K,
        sports: A.SPORT_POOL,
        week_shape: A.WEEK_SHAPE,
        plan_statuses: PL.STATUS,
        plan_roles: PL.ROLES,
        plan_actions: PL.MACHINE,
        risk_thresholds: PL.RISK,
      });
    }
    if (p === "/api/simulate" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const profile = sanitizeProfile(body.profile);
      const athlete = A.generateAthlete({
        seed: body.seed != null ? body.seed : 20261007,
        weeks: body.weeks != null ? Math.max(1, Math.min(16, body.weeks)) : 8,
        sex: profile.sex,
        rest_hr: profile.rest_hr,
        max_hr: profile.max_hr,
        sleep_need: profile.sleep_need,
        hrv_base: profile.hrv_base,
        base_load: profile.base_load,
        start: body.start || "2026-03-02",
      });
      return json(res, 200, { athlete, analysis: AN.analyze(athlete) });
    }
    if (p === "/api/analyze" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const r = AN.analyzeLog({
        sessions: Array.isArray(body.sessions) ? body.sessions : [],
        morning: Array.isArray(body.morning) ? body.morning : [],
        profile: sanitizeProfile(body.profile),
      });
      return json(res, 200, r);
    }
    if (p === "/api/prescribe" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const r = P.prescribe({
        date: body.date || null,
        acwr: body.acwr != null ? Number(body.acwr) : null,
        chronic: body.chronic != null ? Number(body.chronic) : null,
        week_accumulated: body.week_accumulated != null ? Number(body.week_accumulated) : 0,
        readiness: body.readiness != null ? Number(body.readiness) : null,
        readinessLabel: body.readiness_label || null,
      });
      return json(res, 200, r);
    }
    if (p === "/api/periodize" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      return json(res, 200, P.periodizeWeeks(Number(body.base || 500), {
        increment: body.increment != null ? Number(body.increment) : null,
        deload: body.deload != null ? Number(body.deload) : null,
      }));
    }

    /* ---------- 协作计划 ---------- */
    const pm = p.match(/^\/api\/plans(?:\/([^/]+))(?:\/(.+))?$/);
    if (p === "/api/plans" && req.method === "GET") {
      return json(res, 200, { plans: Store.list().map(PL.summary).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)) });
    }
    if (p === "/api/plans" && req.method === "POST") {
      const body = await readJson(req);
      const plan = PL.buildPlan(body, {});
      /* 创建即允许携带历史日志做一次风险快照（仍停留草稿） */
      if (Array.isArray(body.sessions) && body.sessions.length) {
        const ctx = riskContext(plan, body);
        plan.risk = PL.assessRisk(plan, ctx);
      }
      await Store.save(plan);
      return json(res, 200, { plan });
    }
    if (pm) {
      const id = pm[1];
      const sub = pm[2] || null;
      const plan = Store.get(id);
      if (!plan) return json(res, 404, { error: "计划不存在", code: "not_found" });
      const body = ["POST", "PUT"].includes(req.method) ? await readJson(req) : {};

      if (!sub && req.method === "GET") {
        return json(res, 200, { plan });
      }
      if (!sub && req.method === "PUT") {
        if ((body.role || "coach") !== "coach") return json(res, 403, { error: "仅教练可修订计划", code: "forbidden" });
        const updated = PL.rebuildPlan(plan, body.patch || body, {});
        if (Array.isArray(body.sessions) && body.sessions.length) {
          updated.risk = PL.assessRisk(updated, riskContext(updated, body));
        }
        await Store.save(updated);
        return json(res, 200, { plan: updated });
      }

      if (sub === "transition" && req.method === "POST") {
        const ctx = riskContext(plan, body);
        const risk = ["submit", "resume"].includes(body.action) ? PL.assessRisk(plan, ctx) : null;
        PL.transition(plan, body.action, {
          role: body.role || "coach",
          actor: body.actor || "",
          note: body.note || "",
          risk,
          risk_ctx: ctx,
        });
        await Store.save(plan);
        return json(res, 200, { plan: plan });
      }

      if (sub === "review" && req.method === "POST") {
        PL.review(plan, {
          role: "therapist",
          actor: body.actor || "",
          decision: body.decision,
          note: body.note || "",
        });
        await Store.save(plan);
        return json(res, 200, { plan: plan });
      }

      if (sub === "risk" && req.method === "POST") {
        const analysis = planAnalysis(plan, body);
        const ctx = {
          acwr: analysis.today.acwr,
          chronic: analysis.today.chronic,
          readiness: analysis.today.readiness,
          peak_acwr: analysis.projection ? analysis.projection.peak_acwr : null,
          peak_date: analysis.projection ? analysis.projection.peak_date : null,
        };
        plan.risk = PL.assessRisk(plan, ctx);
        await Store.save(plan);
        return json(res, 200, { risk: plan.risk, projection: analysis.projection, plan });
      }

      if (sub === "analyze" && req.method === "POST") {
        return json(res, 200, planAnalysis(plan, body));
      }

      if (sub === "writeback/readiness" && req.method === "POST") {
        const rec = PL.writeReadiness(plan, body.entry || body, { actor: body.actor, role: body.role || "coach" });
        await Store.save(plan);
        return json(res, 200, { plan, entry: rec });
      }

      if (sub === "writeback/load" && req.method === "POST") {
        const analysis = planAnalysis(plan, body);
        const rec = PL.writeLoadWindow(plan, analysis, { actor: body.actor, role: body.role || "coach" });
        await Store.save(plan);
        return json(res, 200, { plan, entry: rec, analysis });
      }

      if (sub === "writeback/prescription" && req.method === "POST") {
        let rec;
        if (body.prescription && typeof body.prescription === "object") {
          rec = PL.writePrescription(plan, body.prescription, { actor: body.actor, role: body.role || "coach", date: body.date });
        } else {
          const analysis = planAnalysis(plan, body);
          rec = PL.writePrescription(plan, analysis.prescription, { actor: body.actor, role: body.role || "coach" });
        }
        await Store.save(plan);
        return json(res, 200, { plan, entry: rec });
      }

      return json(res, 404, { error: "未知计划接口", code: "not_found" });
    }

    let f = p === "/" ? "/index.html" : p;
    const fp = path.normalize(path.join(WEB, f));
    if (!fp.startsWith(WEB)) return json(res, 403, { error: "forbidden" });
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(fp).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      return fs.createReadStream(fp).pipe(res);
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof PL.PlanError) return fail(res, e);
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`athlete-load running at http://127.0.0.1:${PORT}`);
});
