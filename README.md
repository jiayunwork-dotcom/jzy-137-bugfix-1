# 流式雨流计数 / Palmgren–Miner 损伤后端

一个“边收边算”的道路载荷谱后端。采集系统的数据块**来一块吃一块**，
任何时刻都能查询“截至目前累计损伤多少”。计数按 **ASTM E1049-85** 雨流法，
损伤按 **Palmgren–Miner** 线性累积，S–N 取 **Basquin** 形式
`N = C·S^(−m)`，平均应力修正支持 **Goodman** 与**不修正**。

- 语言/运行时：TypeScript，Node 20
- HTTP：Fastify
- 持久化：SQLite（`better-sqlite3`，WAL 模式），文件放在挂载卷
- 测试：Vitest
- 镜像：`node:20-slim`，`docker compose` 一键起服务

---

## 目录结构（按职责拆分）

```
src/
  core/
    types.ts        领域类型、作业配置、错误类型
    peakvalley.ts   峰谷提取（同向合并 / 平台去重 / 滞回门限），流式、状态可序列化
    rainflow.ts     雨流内核（ASTM §5.4.4 三点栈算法，在线版 + 离线参考实现）
    damage.ts       Basquin 损伤、Goodman/不修正、配置校验
  store/
    sqliteStore.ts  作业/数据块/循环的 SQLite 持久化与事务
  service/
    jobService.ts   作业编排：追加、幂等、中间查询、收尾、重启续算
  http/
    app.ts          Fastify 装配
    routes.ts       路由与错误码映射
  server.ts         进程入口
test/               Vitest 测试（核心算法 / ASTM 示例 / 损伤 / 服务 / HTTP）
```

---

## 核心需求：跨块为什么必须逐位一致

一个循环的峰可能在上一块、谷在下一块。本实现保证：

> **同一条时程，无论怎么切块（逐点、随机切、一整块），显式收尾后得到的
> 循环列表与累计损伤完全一致。**

做法是把整条管线写成对样本序列的**左折叠（left fold）**：每个模块都是一个
只持有极小状态、且每个产出都“一旦确认永不撤回”的流式归约器。

### 峰谷提取（`peakvalley.ts`）

在线死区（Schmitt）状态机，状态机四态：`empty / undetermined / up / down`。

- 同向点合并：一条腿只保留运行最高/最低点，中间点被吸收。
- 平台去重：与上一点相等直接忽略（跨块也成立）。
- 滞回门限：以**幅值**为单位，`hysteresis` 表示幅值门限，即峰谷**极差**
  `range >= 2·hysteresis` 才保留；在雨流计数**之前**滤掉。`0` 表示不过滤。
- 每个吐出来的极值都是“已确认”的：之后任何样本都不能把它收回。第一条越过
  门限的腿出现前，在 `undetermined` 态同时跟踪运行高/低，因此腿内反向只是
  移动起点，不会误发极值。
- 整条时程**最后一个尚未确认的极值**只在收尾时由 `flush()` 吐出，收尾前不计。

状态只是几个标量（mode/high/low/last/candidate/anchor），可直接 JSON 落库。

### 雨流内核（`rainflow.ts`）

ASTM §5.4.4 的三点栈算法的在线形式：每压入一个转折点，只要栈顶四个点
`S(n−3) S(n−2) S(n−1) S(n)` 满足

```
X = |S(n−2) − S(n−3)|,  Y = |S(n−1) − S(n−2)|,  Z = |S(n) − S(n−1)|
X ≥ Y  且  Y ≤ Z
```

则中间对 `S(n−2),S(n−1)` 构成一个**全循环**（range=Y），弹出后继续在栈顶复检。

为什么在线版和“整条时程反复扫描”等价：新增一个点后，唯一可能新满足条件的
窗口就是以该点结尾的窗口；一旦某窗口不满足条件，除非再来新点改变 Z，否则它
不会凭空变得可抽取。因此每次只在栈顶复检，即可与标准的整残段反复扫描逐位
相同，且与切块方式无关。栈本身可 JSON 落库。

### 收尾与半循环

显式收尾时：先 `flush()` 最后一个极值（它仍可能闭合若干**全循环**），再把
栈上残余按 ASTM §5.4.4.3 折成**半循环**——残余中每一对相邻点贡献 0.5 个循环，
按残余自然顺序输出（与标准 X1.1 示例表行序一致）。

> 收尾前的中间查询**只含已确定的全循环**；残余不计。收尾后才折成半循环计入。

---

## 跨块残余状态：持久化方案的选择与代价

两条候选路线：

1. **持久化原始时程，每次追加重放整段。**
2. **持久化流式归约器的残余状态（峰谷状态 + 雨流栈），每块只处理新增点。**  ← 本实现

**选择方案 2。** 每块处理完，在**一个 SQLite 事务**里原子写入：
该数据块行、本次新确认的全循环、峰谷状态 JSON、雨流栈 JSON、累计计数。

- **存储代价（方案 2 小）**：不保存原始波形，只保存一个极小的归约器状态。
  雨流栈是残余转折点，量级远小于样本数（几十个点级），与已采集的总点数无关；
  峰谷状态只有几个标量。原始波形规模可达数千万点，方案 1 需要把它们全部落盘。
- **重算代价（方案 2 恒定）**：追加一块只做 `O(本块点数 + 本块新闭合循环)`，
  与历史长度无关。方案 1 每追加一块都要重放全部已存波形，累计耗时随总时长
  二次增长，跑几十小时后每次追加都会越来越慢。
- **重启续算（方案 2 天然支持）**：重启后从库里读回两个状态即可接着追加。
- **方案 2 的代价/前提**：丢弃原始波形后无法回溯重算（本需求只要求当前累计
  损伤与逐循环结果，不需要重放）；正确性依赖归约器的“产出不可撤回”，这一点
  已由状态机构造与随机分块测试保证。若将来需要“改门限重算”，则应额外归档原始
  数据（可加一张只追加的 blob/样本表），那是另一项需求。

数据块另外记录了 `sequence` 与载荷内容的 SHA-256 `checksum`，用于序号连续性
校验与“同序号同内容 = 幂等”。

---

## 损伤模型

- 全循环幅值 `S_a = range/2`，均值 `S_m = (peak+valley)/2`。
- 不修正：有效幅值 `S = S_a`。
- Goodman：`S = S_a / (1 − S_m/UTS)`，**仅当均值为拉（>0）**；
  均值为压（≤0）时**不放大幅值**，`S = S_a`。
  当 `S_m ≥ UTS` 时寿命无定义，返回明确错误。
- 单次损伤 `D = count·S^m / C`，`count` 全循环为 1、半循环为 0.5。
- 累计损伤为逐循环损伤之和（Miner 线性）。查询时由已存循环行重新求和，
  与落库结果始终一致。

---

## HTTP API

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET  | `/health` | 健康检查 |
| POST | `/jobs` | 创建作业，body 为作业配置 |
| POST | `/jobs/:id/blocks` | 按序号追加数据块 `{sequence, values}` |
| GET  | `/jobs/:id` | 查询截至当前结果 |
| POST | `/jobs/:id/finalize` | 显式收尾（幂等） |

创建作业配置：

```json
{
  "C": 1e12,
  "m": 3,
  "correction": "none",
  "hysteresis": 0,
  "ultimateTensileStrength": 1000
}
```

- `correction`：`"none"`（默认）或 `"goodman"`；Goodman 必须给正数
  `ultimateTensileStrength`。
- `hysteresis`：幅值门限，非负数，默认 0。

查询结果：

```json
{
  "jobId": "...",
  "status": "open | finalized",
  "blocks": 12,
  "lastSequence": 12,
  "sampleCount": 30582,
  "cycles": [
    { "amplitude": 20, "mean": 5, "count": 1, "damage": 0.00008, "kind": "full" }
  ],
  "totalDamage": 0.00042
}
```

### 序号与错误约定

- 序号从 1 开始且必须连续；**跳号 → 409**。
- **重复序号 + 不同内容 → 409**；**重复序号 + 完全相同内容 → 幂等 200**。
- 已收尾作业再追加 → 409。
- 非数值 / `NaN` / `Infinity` / 空块 / 超过 200000 点 → 400。
- 配置非法（C、m、门限、Goodman 缺 UTS 等）→ 400。
- 作业不存在 → 404。

---

## 本地开发

```bash
npm install
npm run build        # tsc 编译到 dist/
npm test             # 运行全部 Vitest 测试
npm run dev          # tsx watch 热重载（开发）
DB_PATH=./data/dev.db node dist/server.js   # 直接运行
```

## Docker / Compose

```bash
docker compose up --build
# 服务监听 http://localhost:3000
# SQLite 位于命名卷 rainflow-data 挂载到的 /data/rainflow.db（含 WAL）
```

快速试一发：

```bash
curl -s -X POST localhost:3000/jobs -H 'content-type: application/json' \
  -d '{"C":1e12,"m":3,"correction":"none","hysteresis":0}'
# -> {"jobId":"<id>"}

curl -s -X POST localhost:3000/jobs/<id>/blocks -H 'content-type: application/json' \
  -d '{"sequence":1,"values":[-2,1,-3,5,-1,3,-4,4,-2]}'

curl -s -X POST localhost:3000/jobs/<id>/finalize
```

---

## 测试如何核对需求

- `test/astm.test.ts`：标准 X5 经典示例，全循环与 6 个半循环的
  range/mean/count **逐条对上文献表**。
- `test/core.test.ts`：峰谷提取（同向合并、平台、门限、状态序列化）；
  在线雨流 vs 独立离线参考在 2000 条随机序列上一致；转折点跨块顺序一致。
- `test/service.test.ts`：
  - 逐点 / 随机切块 / 一整块，收尾后循环与损伤**完全一致**（60 组随机，含门限）；
  - 边界恰落在峰值、单点块、全常数块、整体常数无循环；
  - 收尾前中间查询只有全循环，收尾后才出现半循环；重复收尾幂等；
  - 跳号拒绝、重复序号异内容拒绝、同内容幂等；
  - 追加中途“重启”（关闭后用同一 SQLite 文件重开）继续追加，结果与不中断一致；
  - 非数组 / NaN / Infinity / 空块 / 200001 点报错，正好 200000 点接受；
  - Goodman 在全压均值时与不修正结果相同。
- `test/damage.test.ts`：整段乘 2 时幅值/均值乘 2、损伤乘 `2^m`；整体平移常数
  时均值平移、幅值与损伤不变；整体取负时幅值不变、均值取负。
- `test/http.test.ts`：Fastify `inject` 端到端覆盖 201/200/400/404/409 与分块追加。
