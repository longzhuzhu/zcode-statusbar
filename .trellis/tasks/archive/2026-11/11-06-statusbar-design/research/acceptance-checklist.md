# 实机验收清单（stub 测试无法覆盖的人工验收项）

> 来源：design §7、各实现代理报告的未尽事项、检查阶段新发现。实现已通过全部离线测试（Python 178、node 62）。

## A. 渲染端选择器/文案校准（宿主版本登记后逐项确认）

1. `MOUNT_ANCHORS`（statusbar.js）：状态条挂载点在真实 composer 下方正确插入、居中、不与附件 chips 重叠。
2. `STREAM_SELECTORS`（turn-stats.js）：流式回答时能命中正文节点，速度数字实时变化；回答结束速度归零。
3. `RING_SELECTORS`（statusbar.js）+ 官方圆环 aria 文案：色阶覆盖到官方上下文圆环进度描边；Highspeed 锁定模型（圆环缺席）时无残留、无报错。
4. store 直喂钩子 `__ZCODE_STATUSBAR_STREAM_LENGTH__`：如接通官方 store，DOM 选择器链路可停用。

## B. 视觉与交互（AC1–AC6、R12）

5. 深浅主题 × 四主题组下：数字 `foreground-subtle` 可读、色阶锚点色对比度达标（ramp.js 常量区待固化）。
6. 界面字号设置 12–20px 拉动：状态条数字随 `--text-ui-sm` 缩放（宿主字号变更不即时同步插件页为已知限制，验证下次注入生效）。
7. 真实 hover：控件升亮+淡灰背景、Context hover 200ms 提示、详情弹层 Escape/外点关闭。
8. 估算态呼吸动画（约 2s 周期）不明显干扰阅读；tooltip 首句含"估算"。
9. 子代理双态切换无闪烁；活跃数与速度随真实子代理运行变化。
10. 齿轮菜单全项：显示开关即时生效；立即刷新（forceRefresh 清去重键后 session 事件必达）；复制诊断内容完整；重置统计本地即清；检查更新触发 updater.request("check")；卸载弹确认后走 uninstall.py → 自动重启。

## C. 安装/卸载/更新实机（AC7/AC8）

11. marketplace 安装落位后 flat 布局可见性（布局双面性：发布 ZIP core/ 与插件链同步源 flat——见 A-fin 报告残留风险；需真机确认 installPath）。
12. SessionStart 自动注入：未注入时自动安装、已注入时幂等跳过；opt-out 标记生效。
13. 卸载闭环三缺口实机复验：asar 无残留注入行、引擎补丁已 restore、预注入 ZIP 已撤销、config.json/SQLite 保留；重装配置仍生效。
14. Windows 文件占用：运行中卸载触发 install_monitor 收尾监控路径。
15. Release 更新：哈希不匹配拒绝；匹配自动装+热换；冷文件（loader/静态桥）变更走"待重启"标记并齿轮红点。

## D. 多窗口/隔离（R10）

16. 双窗口不同会话：状态条各显各的会话数据，无串数；身份不可确认窗口不渲染。
17. 外部网页（非宿主本地页）：不注入、动作队列不可达（pollPluginRequests 的 file: 协议白名单）。

## E. 暂缓项接线方案（自校准 calibrateFromTurn，CONTRACT §7.3）

- 现状：charsPerToken 固定默认 2，速度为估算（R3 呼吸标识兜底语义正确性）。
- 推荐方案（改动集中在渲染端）：turn-stats 在"文本长度回落=新一轮"时，把上一轮累计流式字符数暂存 window 全局；EVENT_SHIM 收到 `zcode-statusbar:session` 且 detail 中出现新完成主轮 model 行时，读暂存字符数 + 该行 outputTokens，调 `calibrateFromTurn`。
- 备选：statusbar-bridge 直读 store 流式文本长度，轮结束时由内核直接下发 `{outputTokens, charCount}`。

## F. 已知非阻塞事项

- marketplace.json / LICENSE 未入库（发布打包前补齐，A-fin 报告）。
- zusage.py 诊断口径与 UI 口径对缺 first_token 行的分流（双实现同帧差异已实测登记，UI 为权威）。
- `pending_cache_dir` 的 updaterCacheDirName 兜底值依赖宿主目录名（改名时两处同步）。
