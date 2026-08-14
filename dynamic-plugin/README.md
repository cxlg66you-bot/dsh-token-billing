# 动态插件演进史(归档)

动态插件 `tokbl-1`(pluginId)是计费能力的第一个形态:它作为会话级临时插件运行,
随进程重启而消失。五个 Package(pkg-1 ~ pkg-5)记录了从「首个版本」到
「人民币计价 + 面板修复」的完整演进;此后该能力固化为持久版
(仓库根目录 `token-billing.js` + `token-billing-web/`),动态版使命结束。

> 注意:`dynamic-plugin/` 下的文件是动态插件的**函数体**(由 cordis_define 的
> code.host / code.client 提供),不是可直接 import 的 ESM 模块;仅供演进史参考。

## 时间线

| 版本 | 变更 | 结果 |
|---|---|---|
| **pkg-1** | 首个版本:USD 默认价(reasoner 0.55/0.14/2.19、chat 0.27/0.07/1.10)、Run 卡面板、`billing_report` 工具、RPC(summary/reset/set-price/remove-price) | ❌ host-half-failed:`parameters.additionalProperties:false` 不被参数 DSL 接受 |
| **pkg-2** | 去掉 parameters 根节点 `additionalProperties:false` | ❌ host-half-failed:output schema 使用根级 `required` 数组,不被 value schema DSL 接受 |
| **pkg-3** | output schema 改为属性级 `required:true`,`summary` 对象显式 `additionalProperties:true` | ✅ 首个成功运行版本(USD) |
| **pkg-4** | 切换人民币默认价(reasoner 4/1/16、chat 2/0.5/8),账本字段 `costUsd` → `cost` | ⚠️ 宿主成功,但客户端仍读旧字段 `costUsd`,面板渲染崩溃 |
| **pkg-5** | 客户端字段改为 `cost`,并加 `num()`/`cost()` 数值兜底 | ✅ 最终运行版本(¥);随后持久版接管 |

## 每个版本踩过的坑(备忘)

1. **参数 schema 根是隐式开放的**:`harness.defineTool` 的 parameters 根节点
   不允许 `additionalProperties:false`(pkg-1 → pkg-2)。
2. **输出 schema 的 required 在属性上**:value schema DSL 不支持根级 `required`
   数组,必需性用 `{ type: 'x', required: true }` 声明(pkg-2 → pkg-3)。
3. **宿主/客户端字段契约要同步**:宿主改字段名时客户端必须同步,
   否则渲染期 `.toFixed` 崩溃(pkg-4 → pkg-5)。
4. **持久化才是终态**:动态插件的账本在内存中,更新版本会清零、重启会丢失;
   跨会话、跨重启的账单必须落到宿主层 storageDomain(持久版方案)。

## 文件清单

```
dynamic-plugin/
├── README.md          # 本文件
├── pkg-1/host.js      # USD 首版(参数 schema 有 bug)
├── pkg-1/client.js    # USD 面板(pkg-1/2/3 共用)
├── pkg-2/host.js      # 修 parameters
├── pkg-2/client.js    # 同 pkg-1
├── pkg-3/host.js      # 修 output schema —— 首个可运行版
├── pkg-3/client.js    # 同 pkg-1
├── pkg-4/host.js      # 人民币版(与 pkg-5 相同)
├── pkg-4/client.js    # ¥ 面板(仍读 costUsd,渲染崩溃)
├── pkg-5/host.js      # 同 pkg-4
└── pkg-5/client.js    # ¥ 面板修复版(最终运行版本)
```
