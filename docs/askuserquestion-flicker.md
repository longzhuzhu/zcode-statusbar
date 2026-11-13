# AskUserQuestion 展开时的布局振荡

## 定位结果

`statusbar/statusbar.js` 的 `dockBottomMargin()` 把输入框与状态条的**实测距离**
作为目标，再减去祖先的底部留白，写入状态条的 `margin-bottom`。
这个实测距离并非独立输入：纵向 flex 容器分配剩余空间时，底部 margin 又会改变它。

例如固定高度、`flex-direction:column;justify-content:space-between` 的 dock 中，
设剩余空间常量为 C、当前底部 margin 为 m、祖先留白为 p，则旧逻辑近似为：

```text
gap(m) = C - m
m(next) = gap(m) - p = C - p - m
```

连续两次计算会回到原值，形成两态振荡。`render()` 在 turn 样本、session 帧和
每秒定时器中都会执行 `balanceDockGap()`；ResizeObserver 也会触发布局计算。
因此即使询问内容不变，后续统计刷新仍能反复移动状态条。

原有布局测试覆盖普通文档流、嵌套、缩放、分屏等，但没有覆盖询问面板展开后
固定高度 dock 的纵向剩余空间分配。普通文档流中的 gap 不依赖底部 margin，
所以原有 78 个场景全部通过也无法捕获此问题。

## 复现证据

`scripts/check-statusbar-interaction.mjs` 加载真实 `statusbar.js` 和 `turn-stats.js`，
在模拟宿主的官方 `[data-v4-composer]` 内展开 AskUserQuestion 表单，持续接收
turn/session 事件，逐帧采样并检查选项、回答和焦点。

修复前，`space-between` 场景在约 1.6 秒、98 帧采样中：

- 状态条上下移动 24px，底部 margin 在 `-16px` 与 `8px` 之间切换。
- 状态条始终是同一个 DOM 节点，没有重挂或重复挂载。
- 问题表单自身的位置保持不变，未发生 ResizeObserver 错误。

这将已复现的抖动定位为间距补偿反馈，而非询问内容更新或节点重建。
该测试使用模拟宿主布局；当前环境没有 ZCode 客户端，不能代替对应客户端版本的实机验收。

## 修复

- 使用状态条 CSS `margin-top` 作为稳定的目标间距，不再把受反馈影响的实测 gap 用作下一轮目标。
- 在纵向 flex 的非起始对齐布局中回退正常流，让宿主管理剩余空间，清除既有的内联补偿。
- 普通文档流继续回收可由祖先 padding/border/margin 解释的留白；退出询问布局后恢复补偿。
- 同步 `plugins/zcode-statusbar/statusbar.js` 分发副本。

## 验证命令

```sh
npm test
npm run test:layout
npm run test:interaction
python3 -m unittest discover -s tests -p '*.py' -t .
python3 core/sync_plugin.py --check
```

交互回归覆盖深浅主题、普通流和 `space-between` / `space-around` / `space-evenly` /
`center` / `flex-end`，断言逐帧位置稳定、回答与焦点保留、统计继续更新，以及收起后
恢复上下各 4px 的间距。

本次结果：Node 141/141、原有布局场景 78/78、交互场景 12/12 通过，分发副本一致。
12 个交互场景的状态条和询问表单位移均为 0px。

Python 为 193/194：`test_timeout_ends_process_tree_instead_of_waiting_for_inherited_pipes`
在未修改的 `ab11114` 基线上也失败。环境中被杀死的孙进程成为 PID 1 下的僵尸进程，
测试的 `os.kill(pid, 0)` 仍判定其存在；本次没有修改相关安装器或清理逻辑。
