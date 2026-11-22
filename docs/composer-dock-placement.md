# 状态条位置错乱与热重载失效

## 现象

ZCode 3.19.1 真机上状态条位置不稳：有时压在「7 个文件已更改」卡片那一行，
有时下半截被裁掉只剩一条上沿。改动 `statusbar.js` 后界面没有变化。

## 定位结果

真机诊断取到三层独立缺陷，互相叠加。

### 1. `ramp.js` 顶层声明阻断整条注入链

内核 `injectStatusbar` 把四个资产拼成一个脚本串，经
`executeJavaScript` 在页面全局求值；资产 mtime 变化后整串重注入。`ramp.js`
没有 IIFE 包裹，顶层 `const NEUTRAL_COLOR` 等声明进入页面全局词法环境，
第二轮注入直接抛

```text
SyntaxError: Identifier 'NEUTRAL_COLOR' has already been declared
```

SyntaxError 中断整串，排在后面的 `statusbar.js` 再也不执行，内核日志只留下
`renderer assets changed, hot-reloading` 而没有 `injected into wc#`。这就是
「改完代码界面没变化」的原因，也是 0.2.1/0.2.2 的修复在真机上始终看不到的
原因。

### 2. 缺少 `__ZCODE_STATUSBAR_DISPOSE__`，重载叠加孤儿条

内核重载串以
`(function(){if(window.__ZCODE_STATUSBAR_DISPOSE__)window.__ZCODE_STATUSBAR_DISPOSE__();window.__ZCODE_STATUSBAR__=false;})();`
开头，而 `statusbar.js` 从未定义该钩子，清理是空调用。旧实例的 bar、1s 渲染
定时器与全局监听全部留在页面里，每轮重载叠一条并把输入框往上顶。真机实测
两条并存：

```text
{"barCount":2,
 "bars":[{"top":670,"margin":null,"gapBelow":26},
         {"top":696,"margin":"-12px","gapBelow":0}]}
```

一条正常、一条贴裁切边，正是「有时在上、有时在下」的形态。

### 3. 底部留白回收越过滚动容器

`dockBottomMargin` 把祖先 `padding-bottom` 一路累加到 `[data-session-id]`
面板。真机 dock 位于滚动容器内，容器外的 `timeline pb-4`（16px）不在可视区，
却被当成可回收空白，算出 `4 − 16 = −12px`，把条压到裁剪边界，余量归零。

真实页面四态实测（`innerH 738`，滚动视口底 718）：

```text
margin 清空  bar 692–714  gapBelow 4
margin 0px   bar 696–718  gapBelow 0
margin 4px   bar 692–714  gapBelow 4
margin -12px bar 696–718  gapBelow 0   ← 0.2.2 稳态
```

### 4. 锚点未命中宿主实锚点

3.19.1 的 asar 里没有 `data-v4-composer` 属性，只有
`data-testid="v4-composer"`；插件靠 `[class*="composer" i]` 子串兜底命中，
宿主类名一变就漂移。

## 修复

- `ramp.js` 收进 IIFE，模块作用域不再污染页面全局词法环境，可重复注入。
- `statusbar.js` 新增并导出 `__ZCODE_STATUSBAR_DISPOSE__`：清定时器、断开
  ResizeObserver、注销全局监听、移除自身 bar。启动时再清一次历史遗留孤儿条。
- `dockBottomMargin` 改为只在最近的可裁剪祖先内回收留白；容器外的 padding
  不参与，补偿不再把条压到裁切边。
- `MOUNT_ANCHORS` 补上 `[data-testid="v4-composer"]`。

## 验证

```sh
npm run test:composer-dock   # 宿主 dock 内落点、4px 间距、可见余量、重载不累积
npm run test:inject-chain    # 四资产可重复注入，statusbar 每轮都执行
npm run test:layout          # 78 场景
npm run test:interaction     # 12 场景
npm run test:scroll-stability
npm test                     # 141
python3 -m unittest discover -s tests -p "core_*.py"   # 127
python3 core/sync_plugin.py --check
```

真机验收（热重载后读页面真实几何）：

```text
{"barCount":1,"hasDispose":"function",
 "bars":[{"top":692,"bottom":714,"margin":"4px","gapAbove":4,"gapBelow":4}]}
```
