"use strict";
/* 计划 JSON 文件存储（零依赖）：内存 Map + 落盘 data/plans.json。
   单机本地工具，写操作串行化即可满足一致性。 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.PLAN_DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "plans.json");

let cache = null;
let chain = Promise.resolve();

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    cache = new Map(Array.isArray(raw) ? raw.map(p => [p.id, p]) : []);
  } catch (e) {
    cache = new Map();
  }
  return cache;
}

function flush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify([...load().values()], null, 2));
  } catch (e) {
    /* 落盘失败不影响本次内存操作 */
  }
}

function list() {
  return [...load().values()];
}

function get(id) {
  return load().get(id) || null;
}

/* 串行执行变更，保证落盘顺序 */
function mutate(fn) {
  chain = chain.then(() => {
    const r = fn();
    flush();
    return r;
  });
  return chain;
}

function save(plan) {
  return mutate(() => {
    load().set(plan.id, plan);
    return plan;
  });
}

function remove(id) {
  return mutate(() => load().delete(id));
}

module.exports = { list, get, save, remove, mutate };
