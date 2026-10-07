# 个人运动训练负荷与恢复管理系统

基于运动生理学经典模型（Banister 体能-疲劳、sRPE、TRIMP、ACWR）的个人训练负荷量化与恢复状态评估工具。支持合成运动员数据模拟、自定义训练日志分析、当日训练处方建议与四周周期化安排，全部计算在本地完成。

## 快速开始

```bash
npm install
npm run dev
```

启动后自动选择空闲端口并打开浏览器。仅依赖 Node.js 原生模块，无需任何第三方包，macOS / Windows / Linux 均可运行。

## 功能特性

- **训练负荷量化**：
  - sRPE：主观负荷 = 时长 × 自觉强度（1-10 量表）
  - Banister TRIMP：基于心率储备的指数加权积分，按性别取不同的强度系数
  - Edwards TRIMP：五个心率区间（50-60 / 60-70 / 70-80 / 80-90 / 90-100% HRR）时长 × 区间权重的累加
- **急性 / 慢性负荷比（ACWR）**：EWMA 平滑计算 7 日急性与 28 日慢性负荷，含预热期处理（慢性起点取首值），划分不足 / 适宜 / 谨慎 / 危险四档，并给出训练单调性（变异系数 CV）。
- **体能-疲劳模型**：Banister 脉冲响应离散递推，体能时间常数 42 天、疲劳时间常数 8 天，输出每日体能 / 疲劳 / 净表现曲线。
- **恢复状态评估**：晨测 HRV 平衡（lnRMSSD 与基线比值）、睡眠债（近 7 日累计）、静息心率漂移，以及由 HRV、睡眠、主观精力、肌肉酸痛、负荷压力五因子加权合成的 0-100 准备度评分。
- **训练处方引擎**：由当日 ACWR 档位与准备度推导目标强度区间（Z1-Z5，按 %HRR）与负荷范围；目标负荷 = 慢性负荷 × 期望 ACWR − 本周已积累负荷。支持四周递进周期化（基准 → +8% → +16% → 减载 60%）。
- **教练训练计划协作**：教练制定周期计划（按四周块自动展开每日课程）、运动员确认、康复师在高风险时强制复核；计划经 **草稿 → 待确认 → 执行中 → 暂停 → 归档** 流转（暂停后恢复时重新评估，仍高风险则退回复核）。风险引擎综合周增幅、当前 ACWR、准备度、首周冲击、单日峰值与按计划执行的 **投影 ACWR** 给出高风险/关注/可控分级。执行期将 **负荷分析、准备度与每日处方** 回写留痕，高风险日自动把计划课降级为 Z1 恢复课。
- **可视化**：负荷与 ACWR 趋势带（含计划投影段，虚线区分）、体能-疲劳净表现曲线、准备度雷达 / 因子条、四周周期化负荷表、协作计划周视图与时间线。

## 目录结构

```
athlete_load/
├── engine/
│   ├── rng.js            # 确定性伪随机数生成器（同种子可复现合成数据）
│   ├── date.js           # 本地时区日期工具（避免 UTC 回拨）
│   ├── models.js         # sRPE / TRIMP / ACWR / 单调性 / 体能-疲劳模型
│   ├── recovery.js       # HRV 平衡、睡眠债、静息心率漂移、准备度评分
│   ├── prescribe.js      # 当日处方（强度区间 + 负荷范围）+ 四周周期化
│   ├── plan.js           # 协作计划：状态机/权限、风险评估、日程生成、负荷投影、回写
│   ├── athlete.js        # 合成运动员训练历史生成器（生理指标动态演化）
│   └── analyzer.js       # 自定义日志 → 负荷 / 恢复 / 处方全链路分析（可挂计划做投影）
├── web/
│   └── index.html        # 单页前端（模拟训练 / 自定义日志 / 协作计划三视图 + Canvas 图表）
├── store.js              # 计划 JSON 持久化（data/plans.json，零依赖）
├── tests/
│   └── run_tests.js      # 61 项自动化测试
├── server.js             # HTTP 服务与 REST API
├── start.js              # 一键启动（自动选端口 + 打开浏览器）
└── package.json
```

## API

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/system` | GET | 服务信息 |
| `/api/meta` | GET | 运动项目、性别、心率、睡眠等配置元数据 |
| `/api/simulate` | POST | 合成运动员模拟（指定种子 / 周数 / 生理参数） |
| `/api/analyze` | POST | 自定义训练日志 + 晨测数据分析 |
| `/api/prescribe` | POST | 基于当前状态生成当日训练处方与周期化安排 |
| `/api/periodize` | POST | 四周递进-减载周期目标 |
| `/api/plans` | GET / POST | 计划列表 / 教练创建草稿（可带历史日志一并评估风险） |
| `/api/plans/:id` | GET / PUT | 计划详情 / 教练在草稿态修订（版本递增） |
| `/api/plans/:id/transition` | POST | 状态流转：`submit` / `confirm` / `pause` / `resume` / `revise` / `archive`（按角色鉴权，提交与恢复自动重评风险） |
| `/api/plans/:id/review` | POST | 康复师复核：`approve`（解锁确认）或 `request_changes`（退回草稿） |
| `/api/plans/:id/risk` | POST | 用历史日志 + 计划投影重算风险（投影 ACWR 峰值等） |
| `/api/plans/:id/analyze` | POST | 挂载计划的全链路分析：实际 + 投影日、当日计划课程与执行风险 |
| `/api/plans/:id/writeback/readiness` | POST | 回写准备度快照 |
| `/api/plans/:id/writeback/load` | POST | 回写实际负荷窗口（ACWR / 档位 / 累计负荷） |
| `/api/plans/:id/writeback/prescription` | POST | 回写每日处方（计划课 / 降级恢复课 / 休息日） |

计划流转请求示例（高风险时服务端自动挂起康复师复核）：

```json
POST /api/plans/p_xxx/transition
{ "action": "submit", "role": "coach", "actor": "李教练",
  "sessions": [...], "morning": [...], "profile": {...}, "as_of": "2026-03-15" }
```

`/api/simulate` 请求示例：

```json
{
  "seed": 20261007,
  "weeks": 8,
  "sex": "m",
  "rest_hr": 54,
  "max_hr": 196,
  "sleep_need": 7.5,
  "hrv_base": 72,
  "base_load": 500
}
```

响应包含 `days`（逐日负荷 / 急性 / 慢性 / ACWR / 体能 / 疲劳 / 表现 / 准备度序列）、`sessions`（会话明细）、`morning`（晨测指标）与 `summary`（周统计）。

## 测试

```bash
npm test
```

61 项测试覆盖负荷计算边界（零时长 / 零储备）、EWMA 预热期、ACWR 档位划分、体能-疲劳稳态逼近、恢复因子与准备度评分、处方负荷区间、四周周期化增幅、合成数据可复现性与逐日序列完整性，以及协作计划的周期日程生成、状态机与角色权限、高风险康复师复核与退回、暂停恢复重评、负荷投影、执行风险降级与三类回写留痕。
