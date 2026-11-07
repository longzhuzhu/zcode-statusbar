# Implement: ZCode 状态栏插件（执行清单）

> 2026-11-06 用户批准开工，实现在本任务内按以下阶段执行；每阶段一个 commit 便于回退。

## 阶段清单（建议按序，每阶段可独立验证）

1. **脚手架**：plugin manifest、hooks（SessionStart 同步）、稳定运行目录约定、日志与诊断格式。
2. **接入内核移植**：patch_install.py / install.py / inject-main.cjs 移植并裁剪；跨进程锁、指纹、原子替换保持原语义。
3. **数据管道**：zusage.py 裁剪（去价格/额度）、renderer_bridge.py 移植、turn-stats.js 采样、session-stats.cjs 聚合（双口径、缓存命中、子代理）。
4. **色阶引擎**：ramp.js 纯函数 + 单测（先于 UI，便于对照设计稿调色）。
5. **状态条 UI**：statusbar.js 四控件、预留高度、hover、估算态呼吸标识、深浅主题。
6. **圆环增强**：官方圆环色阶覆盖 + hover 详情 + 缺席静默。
7. **弹层与齿轮菜单**：Activity/Usage 详情、短菜单全项、显示开关即时生效。
8. **卸载闭环**：三缺口补齐（引擎 restore 挂接、ZIP 撤销链、失败保留运行目录）+ 端到端用例。
9. **自动更新**：plugin-updater.cjs 校验链 + 待重启标记。
10. **文档**：README（安装/卸载/告知宿主修改/已知限制）、CONTEXT.md 词汇复核。

## 验证命令（实现任务落地时确定具体测试框架）

- 单测：色阶锚点/域外、速度口径边界（200ms、1h、思考窗口）、上下文兜底。
- 回归：安装竞态、篡改、权限保留、降级覆盖阻止、热换失败保留。
- 卸载：三缺口端到端（临时目录模拟）。
- 人工：实机清单见 design.md §7。

## 风险文件与回滚点

- asar 改写相关（patch_install.py / inject-main.cjs）：每次改动必须跑安装竞态回归；回滚 = 反向剥离 + 恢复运行目录上一版（journal）。
- 引擎补丁：仅登记 SHA 可打；回滚 = restore()。
- 实现阶段每个阶段一个 commit，便于二分回退。

## 开工前检查（承接实现任务时）

- [ ] prd/design/implement 三件套已评审（本任务输出）
- [ ] 原插件对应源文件已通读并登记版本差异（ZCode v3.17.2 基线）
- [ ] 测试框架与目录约定确定（.trellis/spec bootstrap 完成后回填）
