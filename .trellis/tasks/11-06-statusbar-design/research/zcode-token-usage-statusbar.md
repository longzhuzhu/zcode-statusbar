# 调研：zcode-token-usage-statusbar（技术原理与安装卸载参考）

> 只读调研，基于检出 `e566da0`（manifest 1.5.12）。调研时间 2026-11-06。

## 接入链路（实际原理）

```
插件市场 / 独立安装器
  → 文件复制到稳定运行目录 /Users/ou/.zcode/zcode-token-usage-statusbar/
  → 改写 app.asar 主入口（out/main/index.js），追加绝对 file:// 动态 import
  → Electron 主进程加载 inject-main.cjs
  → executeJavaScript 注入 turn-stats.js、overlay.js（DOM/CSS 浮层）
  → Python 查询 SQLite + renderer 内部状态桥（静态桥 / React fiber 兜底）
  → 按窗口 / 分栏推送与显示
```

- 正式插件机制（manifest、SessionStart/UserPromptSubmit hooks、命令、stdio MCP）只是**分发与查询渠道**，不是状态栏扩展接口；实际 UI 靠**修改 app.asar + 注入**。
- 实时速度来自 renderer store 字符增量（约 2s 采样窗，100ms tick），属估算，非精确 TPS API。
- 上下文占用优先解析**原生上下文按钮 aria-label**（与宿主面板同源），失败才退 SQLite 最近完成请求。

### 数据源与刷新周期

| 数据 | 来源 | 周期 |
|---|---|---|
| Token/请求/费用统计 | 只读 `~/.zcode/cli/db/db.sqlite`（监听 DB/WAL，300ms 去抖） | 最短 1500ms，30s 兜底 |
| 生成中速度 | renderer store 字符增量 ÷ 每 token 字符数（自校准） | ~2s 采样窗 |
| 上下文占用 | 原生按钮 aria-label → DB 兜底 | 事件驱动 |
| 套餐/余额 | 账号凭据请求供应商接口 | 10min / 15min |
| Git | 本地 git 命令 | 10s |

### 统计口径（原插件现状）

- **速度色是离散十档**（红→黄→绿→青→蓝→紫→浅紫→≥2000 蓝紫渐变+星点），不是连续渐变。`overlay.js:1663-1684`
- 上下文逻辑阈值 30/50/80/90% 五档，但 CSS 实际三色：`<50%` 绿、`50-90%` 黄、`≥90%` 红；**无连续渐变**。`overlay.js:8500-8579`
- 完成态速度 = 会话加权平均（Σ输出 token ÷ Σ生成时长），200ms≤窗口<1h，不含子代理。`zusage.py:967-1078`
- 总 token = input+output；缓存已含在 input，不能重复相加。

## 安装 / 升级 / 卸载机制（值得参考的部分）

- **稳定运行目录**与版本化插件缓存分离；注入行指向稳定目录，不指向会换位置的缓存。
- 安全替换：同目录 stage、跨进程锁、指纹校验、语法/入口自检、原子替换。`overlay_install.py:542-653`
- 运行文件升级保护：hash 基线 + mtime 迁移 + journal，阻止旧版本降级覆盖。
- 热更新：默认 5s 检查；renderer/Python/主进程子模块可热换，loader 自身与静态桥变化需完全重启。
- 版本兼容：renderer 静态桥版本+SHA256+唯一锚点；引擎补丁只允许登记的 SHA。

### 卸载语义（注意，不是"恢复备份"）

- 卸载 = **从当前 asar 反向剥离**自身 loader 和 renderer 桥 + 写 opt-out 标记；旧 `app.asar.zusage.bak` 整体备份机制已退役（避免回滚到旧宿主版本）。
- 引擎补丁正常 restore 也是反向剥离，不覆盖旧文件。

### 新项目需补齐的卸载闭环（原插件已知缺口）

1. 插件 remove 不调用引擎 `restore()`；renderer 桥移除失败不影响总结果。`patch_install.py:1037-1075`
2. 预注入的 macOS 更新 ZIP 无卸载撤销链。`pending_zip_patch.py:2-22`
3. 独立安装器 asar 移除失败仍继续删运行目录，可能留下悬空注入行。`install.py:515-575`

## 冗长提示可删减点（用户要求"去啰嗦"的依据）

- 六分区设置面板 `overlay.js:3872-3996` → 可合并为"显示+维护"。
- prompt-submit hook 每次向**模型**注入"上一条回复速率"背景 `plugins/.../prompt-submit.py:63-79` → 纯显示插件可删。
- 安装失败长会话提示 `overlay_install.py:948-983` → 改为状态条错误入口+可复制诊断。
- 不应删：修改宿主文件告知、凭据披露（若保留额度功能）、估算/真实标识、失败恢复入口。

## 关键风险

1. 宿主升级耦合：DOM、React fiber、内部 store、SQLite schema、bundle 锚点都可能变。
2. 补丁生命周期复杂：安装成功 ≠ 当前进程已加载；热更/冷文件/待替换包/更新 ZIP 需统一状态与对称卸载。
3. 字符估算不是精确 TPS；会话均混合多模型。
4. 额度查询读凭据、更新下载执行代码，不能宣称"纯只读、完全离线"。

## 回归测试可参考

- 安装竞态/篡改/权限：`tests/test_pending_asar.py:85-338`
- 升级保护：`tests/test_runtime_sync_guard.py:98-189`
- 热换：`tests/plugin-hot-swap.test.cjs:127-250`
- 速度分档：`tests/overlay-tps-band.test.cjs:41-168`
- 上下文分档：`tests/overlay-ctxband.test.cjs:27-58`

## 待用户决策（产品权衡）

1. 侵入边界：是否接受修改 app.asar？是否排除引擎补丁与更新 ZIP 预注入？
2. 速度主指标：运行时估算+完成后会话均，还是始终最近一轮？
3. 显示范围：极简（速度+上下文）还是保留累计/Git/额度/费用/子代理？
4. 安装授权：启用即自动修改宿主+默认自动更新，还是首次确认+更新仅提示？
5. 视觉语义：沿用十档速度色，还是少量状态色/连续渐变？上下文显示已用%还是剩余量？
