# ShirtDemo Genesis项目本机路径映射

本页只记录当前主机的项目落点，避免把历史交接路径误当作活动配置。

- 当前项目目标是Genesis＋libuipc＋SIM1双臂叠衣demo；权威入口为`/home/hasinon/ShirtDemo/README.md`，agent维护文档索引为`/home/hasinon/ShirtDemo/gpt-docs/README.md`。
- demo工作树：`/home/hasinon/ShirtDemo/src/genesis_ipc_shirt_demo`；patched Genesis：`/home/hasinon/ShirtDemo/src/genesis-world`。
- 独立运行环境：`/home/hasinon/ShirtDemo/envs/genesis-ipc`；稳定资产映射：`/home/hasinon/ShirtDemo/assets/shirt-demo-assets`；已验收输出：`/home/hasinon/ShirtDemo/outputs/runs`；临时输出：`/home/hasinon/ShirtDemo/outputs/work`。
- 交接与历史证据保存在`/home/hasinon/ShirtDemo/transport`，不覆盖原包。旧目录名中的`robolab_isaacsim`是历史命名，不代表当前物理后端。
- `/home/hasinon/Workspace/robolab`及其PhysX/π0.5/DROID实验是独立历史项目，不是ShirtDemo物理后端或知识主入口。例外：当前已验证的Isaac Sim**离线渲染**配置（`render_jobs/scene527_8000_raytraced_hero_isaac50/config.json`）仍以`/home/hasinon/Workspace/robolab/.venv/bin/python`作为Isaac解释器；这只是视觉流水线的环境路径，不表示衣服物理由RoboLab/PhysX执行。2026-09-26的55k单进程hero/right-grasp已按此配置完成。
- `叠衣服任务模板（红色信息必填）.pdf`仅作后续实机数采流程参考，不是部署依赖或执行指令。

项目状态和待办以`gpt-docs/STATUS.md`与`gpt-docs/TASKS.md`为主要维护入口；本页只维护跨目录路径关系，不复制实验结论。
