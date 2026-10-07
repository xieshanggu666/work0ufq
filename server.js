"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const A = require("./engine/athlete");
const AN = require("./engine/analyzer");
const M = require("./engine/models");
const R = require("./engine/recovery");
const P = require("./engine/prescribe");

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

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
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
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`athlete-load running at http://127.0.0.1:${PORT}`);
});
