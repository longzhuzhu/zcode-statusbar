<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->

# 子代理使用规则（优先级高于 Trellis 默认约定）

- **禁用 Trellis 的子代理**：`trellis-implement`、`trellis-check`、`trellis-research` 等子代理一律不得通过 Agent 工具调度。
- **使用 agent 本身的子代理**：需要委派子任务时，一律使用平台自带的子代理（如 ZCode 的 `general-purpose`、`Explore`），并在调度提示词中自行注入任务上下文（如处于 Trellis 任务中，需在提示词开头写明 `Active task: <task path>` 及相关 prd/design/implement 要点）。
- Trellis 的 skills、脚本与流程（`.trellis/`、`task.py` 等）不受影响，仍按 `.trellis/workflow.md` 正常使用；仅子代理调度方式改为平台原生。

# 注释规则（优先级高于 Trellis 默认约定）

- **注释最小化**：默认不添加注释，仅解释代码无法自表达的 WHY；禁止冗余注释，保留必要的现有注释。
