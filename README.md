# dsh-token-billing

DeepSeek Harness(dsh)持久化 Token 计费插件:按每次模型调用的 token 用量计费,
默认人民币单价,账单落盘持久保存,并提供对话工具、统计栏金额与设置面板三处入口。

## 功能

- **计量**:挂在 `llm/stream` 瀑布事件上,零侵入透传所有 chunk,读取每次模型调用的
  `inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens`
- **计费口径**(与 DeepSeek 官方一致):
  未命中缓存输入 + 缓存写入 × 输入单价;缓存读取 × 缓存读单价;输出 × 输出单价;推理 token 默认按输出单价
- **持久化**:账单存于宿主 `storageDomain`(`~/.dsh/storages/token_billing.json`),
  跨重启、跨会话累计;单价表同样持久化,可随时修改
- **默认单价**(¥ / 1M tokens,DeepSeek 官方价,可改):

  | 模型 | 输入 | 缓存读 | 输出 |
  |---|---|---|---|
  | `deepseek-reasoner` | 4 | 1 | 16 |
  | `deepseek-chat` | 2 | 0.5 | 8 |
  | `*`(兜底) | 2 | 0.5 | 8 |

- **三处入口**:
  1. 对话工具 `billing_report`(report / list-prices / set-price / remove-price / set-currency / reset)
  2. 输入框下方统计栏实时金额:`💰 本会话 ¥x · 累计 ¥y · N 次调用`(每 5 秒刷新)
  3. 设置 → 「Token 计费」实时面板(总量、按会话、最近调用、单价表、清零按钮)

## 目录结构

```
dsh-token-billing/
├── token-billing.js        # 宿主插件:计量 + 计费 + 持久化 + billing_report 工具 + HTTP API
├── token-billing-web/      # Web 客户端包(dsh.client)
│   ├── package.json        #   dsh.client 声明与 exports(必须含 ./package.json 子路径)
│   └── lib/
│       ├── index.js        #   空宿主半(行挂载用)
│       └── client.js       #   统计栏金额 + 设置面板(手写 ModuleLoader bundle)
├── dynamic-plugin/         # 动态插件演进史归档(pkg-1 ~ pkg-5,见该目录 README)
├── docs/screenshots/       # 界面截图清单与拍摄说明
├── cordis.patch.yml        # profile patch 层插入示例
├── LICENSE                 # MIT
└── README.md
```

## 界面预览(截图)

插件生效后,计费信息出现在三个位置(截图清单与拍摄方法见
[docs/screenshots/README.md](docs/screenshots/README.md)):

1. **统计栏金额**(输入框正下方):`💰 本会话 ¥x.xxxx · 累计 ¥y.yyyy · N 次调用`,
   每 5 秒自动刷新;
2. **设置面板**:侧边栏 → 设置 → 「Token 计费」,含总量、按会话明细、
   最近调用、单价表与「清零账单」按钮;
3. **Run 卡面板**(仅动态插件时代):旧版临时面板,重启后由前两者接管。


## 安装(以 `dsh --profile web` 为例)

1. 把仓库内容放到 profile 目录:

   ```bash
   cp -R dsh-token-billing/. ~/.dsh/profiles/web/
   ```

2. 建立包链接(clientModules 以 bare 名解析 `token-billing-web`):

   ```bash
   mkdir -p ~/.dsh/profiles/web/node_modules
   ln -sfn ../token-billing-web ~/.dsh/profiles/web/node_modules/token-billing-web
   ```

3. 把 `cordis.patch.yml` 中的 `insert` 块合并进
   `~/.dsh/profiles/web/cordis.patch.yml`(保留文件原有头部注释)。

4. 重启 `dsh web`,然后刷新浏览器页面。

宿主插件依赖 `zod`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-storage-domain`,
这些都会通过 dsh 维护的 `~/.dsh/profiles/node_modules` 平铺回退目录解析,无需手动安装。

## 使用

- 对话里直接说「查一下账单」,助手调用 `billing_report` 返回报告
- 修改单价:`billing_report` 的 `set-price`(pattern + input/output/cacheRead/cacheWrite/reasoning)
- 切换币种:`set-currency`(如 CNY / USD)
- 清零:`reset`,或设置面板中的「清零账单」按钮
- 统计栏与设置面板每 5 秒自动刷新

## HTTP API(客户端面板使用)

- `GET /api/token-billing/summary` — 总量、按会话聚合、最近 12 次调用、单价表
- `POST /api/token-billing/reset` — 清零账单

## 注意事项

- 账本最多保留最近 300 条调用明细,总额与会话聚合不受影响
- 运行中的宿主不保证热加载 patch 层;修改后请重启 `dsh web`
- 若统计栏/设置页未出现,先硬刷新浏览器(Cmd/Ctrl+Shift+R)
