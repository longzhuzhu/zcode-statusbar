# 现状审计与验证记录

审计日期：2026-11-07。对象为当前工作区，不是仅 HEAD。未运行安装器、未操作真实宿主、未读取用户数据库。所有动态实验使用 VM 假 DOM 或内存 SQLite。

## 基线

- `node --version`：v24.13.0；`python3 --version`：Python 3.14.6。
- `npm test`：62 tests，62 pass，0 fail。
- `python3 -m unittest discover tests -p '*.py'`：178 tests，OK（11.115s）。
- `python3 core/sync_plugin.py --check`：插件副本与源文件一致。
- `git ls-files '.github/*' '*lint*' '*format*'` 未发现仓库级 CI、lint、format 配置；不能据此断言远端没有组织级规则或外部流水线。
- 根 README 只有标题与一句简介，仓库未跟踪产品截图、CONTRIBUTING、SECURITY、CHANGELOG。
- 开始前已有 5 个修改文件：`core/plugin-updater.cjs`、`core/runtime_install.py`、插件包对应两份副本与 `plugins/zcode-statusbar/hooks/session-start.py`。本轮未修改这些文件。

### 最终复核：工作区发生外部变化

上述副本一致性是首次基线结果，不代表最终工作区状态。最终复核期间出现第 6 个源码修改：`core/plugin-release.cjs`，新增本地 marketplace 注册名识别；该修改非本轮所做。连续两次执行 `python3 core/sync_plugin.py --check` 均以退出码 1 报告 `plugin-release.cjs` 副本过期。为避免覆盖并行工作，本轮未运行写入式同步，也未修改该源码或副本。

最终 Node 仍为 62/62，Python 为 178/178（11.461s），文档内两组复现再次成功，`git diff --check` 通过。最终结果必须表述为“单测通过，生成副本检查失败”，不能汇总为全绿。后续实施或发布前需由修改持有方完成同步并重跑门禁；这也验证了源码/分发产物一致性必须进入 CI，而不能依赖人工记忆。

## F1：重复注入缺少完整生命周期闭环（P1）

源码：`core/inject-main.cjs:1040-1054,1075-1076`，`statusbar/turn-stats.js:146-234`，`statusbar/statusbar.js:796-935`。

加载器在 dom-ready、did-finish-load 和热重载时注入资产，热重载尝试调用 `__ZCODE_STATUSBAR_DISPOSE__`。UI 未定义该清理函数，也没有跨注入实例的挂载守卫；局部 `state.mounted` 只能保护当前闭包。采样器安装时同样没有调用旧实例的 stop。

动态验证：同一 VM 执行实际 turn-stats.js 两次，intervals=2、observers=2；再调用最新全局 API.stop()，仍剩 intervals=1、observers=1。

确认范围：采样器资源残留已复现；UI 重复挂载由源码路径推断，真实宿主事件时序、页面导航与长期内存增长尚未实测。

## F2：闲置降频条件失效，并影响完成态显示（P1）

源码：`statusbar/turn-stats.js:155-185,201-207`，`statusbar/statusbar.js:625-635`。

`lastReadAt` 在每次找到消息节点时更新；下一次 100ms tick 与它仅相差约 100ms，永远达不到 5s 闲置阈值。即使没有 DOM 变化、没有字符增长，仍持续查询 DOM、读取 textContent 并发布新样本。UI 又把 updatedAt 新鲜直接当作生成中，没有独立生成状态。

动态验证：固定文本、无观察器通知，假时钟推进 20s；发生 200 次 DOM 查询和 200 次发布，最后样本 `{tokPerSec:0, estimated:true, updatedAt:20900}`，样本年龄 100ms。按 currentSpeed 条件仍选择估算态，无法因 3s 过期切回核实值。

这说明逻辑错误与不必要工作存在，不等于测出了真实 CPU 占用或卡顿。

## F3：子代理行在逐窗口聚合时丢失（P1）

源码：`zusage.py:1140-1162,1191-1221`，`core/inject-main.cjs:526-558`。

投影为子代理行保留子会话自身的 sid。loader 按 sid 分桶，然后仅将主窗口当前会话 sid 对应的桶传给 aggregate，没有按 parent_id 归属取回子会话行。

动态验证：内存库建立一个主会话、一个 parent_id 指向主会话的子会话，分别写入 completed 主请求与 running 子请求。使用实际 `_project_request_rows()` 和从源码抽取的实际 `handlePayload()`：

```json
{"projectedRows":2,"subRows":1,"directSubagentActive":1,"frameSubagentActive":0,"frameSubagentTokens":0}
```

建议：区分来源 `sessionId` 与归属 `ownerSessionId`，维护准确父子关系；不能用全量行混合聚合，否则会引入跨窗口串数。

## F4：明细上限被用作累计统计范围（P1）

源码：`zusage.py:144,1191-1236`，`core/inject-main.cjs:534-556`，`statusbar/session-stats.cjs:103-145`。

recent 三类查询各限 cap，合并后再截断为最近 cap（默认 8000），UI 的 totalTokens/turns/steps 又由该截断集合计算。长会话的“累计”因此只是最近行累计；多窗口共享 cap，还可能互相挤占明细。

动态验证：4 条主请求，输入输出合计 480；将同一函数 cap 缩小为 2 后返回 2 条、合计 240。此为缩小护栏的逻辑复现，尚未做 8000+ 行真实宿主实验。

建议：全量累计摘要与有界趋势/明细分别查询、分别标明范围，不能简单去掉护栏。

## F5：契约、实现与操作语义漂移（P1/P2）

- `statusbar/CONTRACT.md:41,128-129` 要求 session detail 直接为 aggregate，实际 loader 包裹 aggregate，UI 在 `statusbar/statusbar.js:616-621` 兼容包装。
- CONTRACT §3 称 reset 由内核清统计，§7.6 又称无内核消费方；`statusbar/statusbar.js:543-548` 实际只清本地显示，下一次会话快照可将历史数值恢复。是否改成基线重置或移除/改名，需要用户确认。
- `core/inject-main.cjs:1054` 重载补推 lastGoodPayload 未走逐窗口 aggregate 构造，是否影响首次显示应补集成测试。
- CONTRACT 注入顺序描述与 loader 的 turn-stats/ramp 顺序不同；两者都在 UI 前，不据此宣称现有运行必坏，但权威文档必须统一。

建议：采用版本化事件信封与语义夹具测试，不能靠更多“偏差登记”长期代替唯一事实来源。

## 结构与可维护性

当前行数：`core/inject-main.cjs` 1106、`core/patch_install.py` 1183、`core/runtime_install.py` 973、`zusage.py` 1523、`statusbar/statusbar.js` 940。行数是导航线索而非强制拆分标准；真正问题是安装/更新/热换/数据泵/窗口路由集中，UI 也同时负责主题、挂载、菜单、数据显示和宿主圆环修改。

- `core/runtime_lock.py:26`、`core/release_unpack.py:49` 与两个插件 manifest 分别维护文件列表；`core/sync_plugin.py:32` 按 core → statusbar → 根目录探测源位置。
- 分发副本是独立安装的现实约束，不应直接删除。应先把生成与漂移检查放入发布门禁，再考虑布局迁移。
- `zusage.py:484` 存在绑定单机 Windows 路径与日期的模型目录默认值；应由宿主安装路径发现并保留配置兜底，不等于当前所有统计都因此不可用。
- marketplace 和两份 plugin manifest 的 homepage/repository 指向 `zcode-statusbar/zcode-statusbar`，当前 git origin 为 `longzhuzhu/zcode-statusbar`；正式发布前确认权威地址，不能擅自认定仓库迁移意图。
- frontend spec 仍为模板；backend 除 statusbar-kernel 外多项为模板。应填写实际约定或移除空索引，而不是扩充无用文档。

## 视觉与交互：仅静态审阅

已有优点：紧凑横条、宿主主题变量、tabular-nums、估算提示、色阶、复用官方圆环；保留而不是推翻。

源码：`statusbar/statusbar.js:189-230,296-405,709-726,861-925`。

- 未提供窄窗口自适应规则；弹层固定最小宽度且无视口碰撞处理，需要窄栏与大缩放实测。
- 持续呼吸动画没有 reduced-motion 分支；估算与核实还应有文本符号区分，不能只靠颜色/动画。
- 弹层有外点和 Escape 关闭，但未建立完整 aria-expanded、aria-controls、焦点进入/返回策略。
- 高频更新区域直接使用 role=status，应检查屏幕阅读器是否反复播报；不能简单为每个 tick 增加 aria-live。
- 圆环修改用 setAttribute('style', ...) 覆盖整个内联样式，缺少原值恢复闭环；应只改目标属性并在 dispose 恢复，避免破坏宿主其他样式。
- 未做实际窗口截图审查、对比度测量或视觉回归，因此不能认定当前视觉效果已验收。

## 外部核验

- [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)：验证 IPC sender、不向不可信内容暴露高权限能力。当前已有本地宿主页校验与动作白名单，应保留并测试，不是建议降低安全约束换“简洁”。
- [GitHub 社区健康文件](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file)：支持 CONTRIBUTING、SECURITY、Issue/PR 模板等贡献基础设施。这里只确认本地缺项，没有检查账号级继承。

## 可重复实验：采样器

在仓库根执行；仅 VM 内模拟，不连接宿主：

```sh
node <<'JS'
const fs = require('node:fs'), vm = require('node:vm');
const src = fs.readFileSync('statusbar/turn-stats.js', 'utf8');
let now=1000, reads=0, observers=0, seq=0;
const timers=new Map(), published=[];
const document={body:{},querySelectorAll(){reads++;return [{textContent:'completed message'}];}};
const window={document,dispatchEvent(e){published.push(e.detail);},
  CustomEvent:class{constructor(name,opts){this.detail=opts.detail;}},
  MutationObserver:class{constructor(){observers++;}observe(){}disconnect(){observers--;}}};
const ctx=vm.createContext({window,Date:{now:()=>now},
  setInterval(fn){const id=++seq;timers.set(id,fn);return id;},clearInterval(id){timers.delete(id);}});
vm.runInContext(src,ctx);
for(let i=0;i<200;i++){for(const fn of [...timers.values()])fn();now+=100;}
console.log({reads,published:published.length,last:published.at(-1)});
vm.runInContext(src,ctx);
console.log({intervals:timers.size,observers});
window.__ZCODE_STATUSBAR_TURN_API__.stop();
console.log({afterStopIntervals:timers.size,observers});
JS
```

## 可重复实验：父子会话与累计上限

使用项目现有测试 schema；仅内存 SQLite。Node VM 抽取实际 handlePayload，禁止执行整个 Electron loader：

```sh
python3 <<'PY'
import json, sqlite3, subprocess
import zusage
from tests.data_zusage_snapshot import SCHEMA
con=sqlite3.connect(':memory:'); con.row_factory=sqlite3.Row; con.executescript(SCHEMA)
con.execute("insert into session(id,parent_id) values('sess_main',null)")
con.execute("insert into session(id,parent_id) values('sess_subagent_one','sess_main')")
for rid,sid,source,status,t in [('m1','sess_main','main_turn','completed',1000),('s1','sess_subagent_one','subagent','running',2000)]:
    con.execute('insert into model_usage(id,session_id,query_source,status,started_at,first_token_at,completed_at,input_tokens,output_tokens,model_id) values(?,?,?,?,?,?,?,?,?,?)',
                (rid,sid,source,status,t,t+200,t+1000 if status=='completed' else None,100,20,'test'))
rows=zusage._project_request_rows(con,['sess_main'])
script=r'''
const fs=require('node:fs'),vm=require('node:vm');
const stats=require('./statusbar/session-stats.cjs');
const rows=JSON.parse(fs.readFileSync(0,'utf8'));
const loader=fs.readFileSync('core/inject-main.cjs','utf8');
const start=loader.indexOf('function handlePayload(payload)');
const end=loader.indexOf('\nfunction killResidentForUpgrade()',start);
let frame; const wc={id:1,isDestroyed:()=>false};
const context=vm.createContext({sessionStats:stats,webContents:{getAllWebContents:()=>[wc]},
  isMainWindowState:()=>true,activeSid:new Map([[1,'sess_main']]),pushSession:(w,p)=>{frame=p;},
  pushCount:1,readCfgCached:()=>({diag:false}),LOG:()=>{}});
vm.runInContext(loader.slice(start,end),context);
context.handlePayload({recent:rows});
console.log({projectedRows:rows.length,subRows:rows.filter(r=>r.isSubagent).length,
  directSubagentActive:stats.aggregate(rows,4000).subagent.activeCount,
  frameSubagentActive:frame.aggregate.subagent.activeCount});
'''
subprocess.run(['node','-e',script],input=json.dumps(rows),text=True,check=True)
con.execute("delete from model_usage where query_source='subagent'")
for i in range(2,5):
    con.execute("insert into model_usage(id,session_id,query_source,status,started_at,first_token_at,completed_at,input_tokens,output_tokens,model_id) values(?,'sess_main','main_turn','completed',?,?,?,100,20,'test')",(f'm{i}',i*1000,i*1000+200,i*1000+1000))
for cap in (8000,2):
    rows=zusage._project_request_rows(con,['sess_main'],cap=cap)
    print({'cap':cap,'rows':len(rows),'tokens':sum(r['inputTokens']+r['outputTokens'] for r in rows)})
con.close()
PY
```
