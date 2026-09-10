# The showcase site — 交付记录

`apps/storefront-web` 从一个参考前端升级成**给潜在用户看的能力演示页**。
这份文档记的是它是什么、结构怎么组织、以及**做的时候踩到并修掉的实锤问题**——
后者是重点：这个页面唯一的说服力来自「页面上写的每一句都能核」，所以任何一处
「声称」与「实测」对不上，都是这个页面最贵的 bug，比排版难看贵得多。

线上演示部署在内网，公开仓库里不放地址；本地怎么跑见 README。

## 页面是什么

首页是场景总览；每个视角一页，三栏、锁定视口高度：

1. **左栏是这个场景下的视角列表**，顶栏中间切场景。两处都固定不动。
2. **中间一台可以真的点的手机**——固定 390×800 的逻辑视口，所以里面的 App 是按手机写的，
   不是把网页压窄；整台按视口高度缩放（`--phone-scale`，CSS `atan2` 算比例），笔记本上
   也整台可见。手机下面一枚状态胶囊显示会话阶段。
3. **右栏是唯一滚动的区域**：时间线按真实事件点亮，能力卡每张都带 `evidence` 指向本仓库
   里证明它的那个文件/字段；然后是怎么接、延伸场景、文档入口。

整站限宽 1480 居中，超宽屏两侧有发丝线。窄于 1120px 退回普通文档流。
视觉上从 AgentHub 品牌只取那一个绿和那只章鱼，其余按产品官网的标准另做（`globals.css`
文件头有说明）；手机屏幕里的东西是被演示的产品，不受这套规则约束（`mobile.css`）。

## 加一个 case 要改什么

只有两处：

1. `lib/showcase/cases.ts` 加一条记录（文案、配色、能力清单、示例问题、agent 片段、延伸场景）。
2. 写一个手机端 App 组件，在 `components/showcase/CaseStage.tsx` 里挂上。

导航栏、路由 `/showcase/<id>`、能力面板都读这个注册表，不需要第三处改动。
`capabilityOverrides` 用来纠正**这个 case 专有的引用**——能力目录里存的是通用文案，
但「证据」是 case 专有的，把 merchant 面板指向 `cma-shopping/agent.yaml` 是错引，
而在一个整体论点是「你去核」的页面上，错引比缺引贵。

## 能力目录的纪律

`lib/showcase/capabilities.ts`：

- 每条都必须有 `evidence`，写仓库里的真实路径/字段，页面直接显示。
- **做不到的不写成能力卡**，放到「还能这样用」里——那一段是明确的延伸设想，不是声称。
- `signal` 是让它亮起来的运行时事件；`signal: null` 的卡永远不亮，只解释。
  **不亮是诚实的，被无关事件点亮的卡不是。**
- 带 `tools` 的能力，光有 signal 不够，必须它自己的工具真的被调用过才亮。

## 流式

`/api/agenthub/stream` 是服务端 SSE 代理：token 不能进浏览器，所以由服务端持有
`sessions.streamEvents`，逐帧转给页面。`id:` 带 `seq`，浏览器自动重连时回填
`Last-Event-ID` 续上——外层网关 60s 掐空闲连接、控制面 300s 主动关连接，两种都能恢复。

chunk 结构记在 `lib/agenthub/stream-chunks.ts`，是从真实一轮抓下来的（808 条，
test session `b1dda827`），不是照着类型猜的——SDK 把 `chunk` 标成 `unknown`。
抓出来最要紧的一件事：

```
reasoning-delta  x662   seq 4…695
text-delta       x109   seq 697…805
```

回复正文要到整轮 86% 的位置才开始吐。**只流正文的话，前 40 秒仍然是空白**——
流式本来要解决的就是这个空白。真正有内容可显示的是工具轨迹：`tool-input-start`
一调用就报出工具名，`tool-output-available` 直接带着 `present_*` 的卡片数据，
所以卡片能在模型写下第一个字之前就渲染出来。

终态判定归 `waitForTurn`，不归这条流（SDK 文档明确它不带轮次生命周期语义）。
settled 之后的渲染整个替换掉流式画的内容，所以掉线最多损失动画，不损失内容。

## 踩到并修掉的实锤

### 页面声称与实测对不上（最贵的一类）

**导购 agent 根本没连这个 App 的后端。** `cma-shopping/agent.yaml` 的
`BACKEND_BASE_URL` 一直没设，agent 跑的是沙箱内嵌的 MockRetail——它自己的一份购物车。
而页面上写着「它读写的是这个 App 真实的购物车」。实测：往 App 购物车放 `AR-1104`，
问 agent「What is currently in my cart」，答「你的购物车目前是空的」。

修法是让声称成真而不是删掉声称：指向 test 部署。双向都复验过——App 侧 API 放的
`AR-1104`/`AR-1304` agent 读得到；让 agent 加 `AR-1201`，App 侧 `cart/get` 读回三件。

**能力卡在虚报。** 「记忆」和「反向调用业务后端」原来挂在裸 `tool-call` 信号上，
`search_products` 一调用它们就亮，等于告诉观众 agent 用了记忆——它没有。
现在带 `tools` 白名单的能力必须它自己的工具真的被调用过才亮。

### 静默丢失

**未知组件被静默丢卡。** 原来 `VALID_COMPONENTS` 是手工维护的白名单，漏一个就是静默丢弃：
回复正文和工具轨迹都正常，卡片就是不出现，跟「agent 选择不展示」完全无法区分。
merchant 的 `metrics` 卡就这么丢了一天。现在白名单不再决定是否渲染，
`displayed === true` 决定；没有对应组件的显示成「还没有渲染实现」+ 原始 payload。
**丢不掉的错误比丢得掉的正确重要。**

**卡片高度为 0。** `.m-thread` 是 column flex，卡片作为 flex item 会先被压扁而不是让容器滚动。
`plan` 卡带 4 个步骤 4 个商品，实测 `height: 0`——DOM 里在、屏幕上没有。
和上一条是同一种形状：看起来像「agent 没返回」。

**merchant_id 两边不一致。** `/operator` 写死 `acme-retail`，建会话注入 `acme-outdoors`，
结果是审批队列恒为空、且没有任何地方报错。收敛到 `lib/showcase/merchant.ts` 一处。

### 接上真后端之后的连带影响

**评测被演示流量污染。** 绑定 `BACKEND_BASE_URL` 让购物车从「沙箱内一份」变成
「所有人共用、且持久化」。eval 会话不传 `configValues`，于是继承 stdio server 自己的
`demo-user` 默认值，开始读写线上演示的购物车。

实测（eval run `9b867d0e`）：`readme-camping-trip-flow` 第三轮说「add the family one to
my cart」，模型调 `get_cart` 看到三件手工测试留下的无关商品，整轮都在问「是指键盘吗？
还是弹力带？」，始终没调 `add_to_cart`。

这不是偶发——演示页是公开的，往后每次 eval 都会看到访客留下的东西，每次 eval 也会往访客
购物车里塞东西。修法：`agent.yaml` 的 env 设 `CMA_END_USER_ID: eval-user`（默认身份，
实际效果是 eval 的身份；storefront-web 用 `configValues` 传 `demo-user`，优先级更高）。
固定数据里补了 `eval-user`，偏好和订单镜像自 `demo-user`（订单号加 `-E` 后缀），
所以读侧用例仍有历史可用，只有购物车是它自己的。

**教训的一般形状**：把一个 agent 从内嵌 mock 切到共享后端，改的不只是数据来源，
是**状态的生命周期**——从「每会话一份」变成「全局一份且持久」。凡是依赖干净初始状态的
东西（评测首当其冲）都会被这个改动波及，而波及的方式是「模型看到了不该看到的上下文，
于是走了另一条路」，不是报错。

## 已知遗留

- **演示购物车在所有访客之间共享。** 两个人同时看演示会互相看到对方加的东西。
  要修得给每个浏览器分配独立身份，但偏好/订单固定数据是按 `user_id` 索引的，随机身份会
  退化成没有历史的 Guest——得让后端把「读走固定人设、写走每访客购物车」拆开。
- **eval 之间也不隔离。** `eval-user` 的购物车在多次 eval 运行之间是延续的，
  第 N+1 次会看到第 N 次留下的东西。上面那个拆分能一并解决。
- **eval суite 与当前模型不匹配。** 判据里有「恰好调用 1 次 `search_products`」这类精确
  计数和回复正则；suite 是照着 CMA 自己的模型默认值（sonnet/opus 档）写的，这个部署跑的是
  `deepseek-v4-flash` + `effort: low`。目前 2 个用例稳定挂在这上面
  （`readme-single-search-no-clarification` 调了 2~3 次、`provenance-gate-self-corrects`
  搜索 0 结果后没有自我纠正）。**没有绿的基线可比**——在这之前 suite 从未有过一次 6 个用例
  全部被真正评估的运行（更早的几次全是 `infrastructureError`），所以不能说这是回归。
  要么换模型档，要么重写判据——但**不能把判据放松到把当前行为钉成期望**。
- 商品图是按分类调色板 + 手绘图形生成的：固定数据集 87 件商品里只有 9 件有 `image_url`。
- `CMA_ENABLE_DISCLOSURES` 仍然关着：后端的 `/api/backend/disclosure` 对所有 id 返回 `null`，
  开了会变成「工具注册了但每次调用都被拒」。要先写 disclosure 固定数据。
