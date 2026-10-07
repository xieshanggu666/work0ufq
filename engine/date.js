"use strict";
/* 本地时区日期工具：避免 toISOString 的 UTC 偏移导致日期回拨一天。 */

function fmtLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function parseIso(s) {
  return new Date(s + "T00:00:00");
}

/* 从 from（含）到 to（含）的日期字符串序列 */
function daysInRange(from, to) {
  const out = [];
  const cur = parseIso(from);
  const end = parseIso(to);
  while (cur <= end) {
    out.push(fmtLocal(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

module.exports = { fmtLocal, parseIso, daysInRange };
