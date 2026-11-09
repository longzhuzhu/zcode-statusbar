# zcode-statusbar（插件包说明）

ZCode 客户端状态条插件：在输入框下方以视觉化控件呈现生成速度（tok/s 连续色阶）、
累计 token、缓存命中、上下文圆环与子代理状态。状态条仅在真实会话内显示，首页/新建任务不渲染。

## 行为边界

- 接入方式：修改宿主 `app.asar` 主入口追加动态 import（需完全退出并重开 ZCode 生效）；
  SessionStart 自动安装/修复，卸载入口写 `.plugin-statusbar-optout` 豁免标记。
- 零会话干扰：不做回答末尾统计行，不做 prompt-submit 模型注入。
- 数据边界：只读本地 SQLite + renderer 状态桥；不读取账号凭据、不请求供应商接口。
- 不改官方 UI：官方上下文按钮的 DOM、样式、弹层与交互保持原样；状态条自绘自己的上下文圆环，
  数据只读宿主已有的隐藏锚点。
- 联网触点：仅 Release 自动更新（渠道/版本/文件集/SHA256 校验）。
- 卸载保留运行目录（`~/.zcode/zcode-statusbar/`）中的配置与统计数据。

## 目录

- `hooks/` SessionStart 钩子（同步运行时、自动安装）
- `../../core/` 接入内核（注入/剥离、loader、引擎补丁、更新 ZIP 预注入、Release 更新器、卸载编排）

详见仓库根 README。
