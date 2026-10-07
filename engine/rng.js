"use strict";
/* 确定性伪随机数生成器：mulberry32，保证同种子产出相同训练历史。 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function range(rng, min, max) {
  return min + rng() * (max - min);
}

function int(rng, min, max) {
  return Math.floor(range(rng, min, max + 1));
}

module.exports = { mulberry32, range, int };
