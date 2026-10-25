# 测试夹具

这里放**必须随仓库提交**的测试用固定数据。不要放进 `tmp/` —— 那是可随时清空的临时区，
测试一旦依赖那里的文件，清一次临时目录就会失败（2026-10-25 就踩过这个坑）。

## legacy-templates.json

画幅逻辑修复（2026-10-24）**之前**的 `data/templates.json` 快照（version 3，5 个画幅）。

- 用途：`scripts/test-layouts.mjs` 用它核对 `web/app.js` 里 `LEGACY_STRUCT` / `LEGACY_CONTENT`
  迁移注册表与"真实的旧默认文案"逐字一致 —— 注册表写错一个字，老存档就迁移不掉。
- 来源：从 `_backup/20261022-人物参数/data__templates.json` 复原，已逐字比对通过
  （5 个画幅 × format/style/negative/layout 全部一致，outfit/info/realism 三条内容段也一致）。
- 维护：**不要手改这个文件**。它代表修复前的历史状态；要更新迁移规则，请改 `LEGACY_*` 或加新版夹具。
