# 同事安装

在工具仓库运行 `node scripts/install/install.mjs https://your-https-host/mcp`。这会把 Skill 复制到个人 `$CODEX_HOME/skills/team-collab/`，并生成个人 `team-collab-mcp.toml.example` 示例；**不会改动现有 config.toml**。把示例区块复制到个人 Codex 配置并让启动 Codex 的进程读取个人 `COLLAB_TOKEN`。配置后重启 Codex，检查 MCP 工具是否出现。

如果只想人工协作，安装 Skill + MCP 即可；需要自动领取任务时，还要在同事本机启动 Runner。每人使用自己的令牌，不能共用管理员凭据。Runner 跑代码和测试必须是受信任的代码仓库。通过私有网络或 HTTPS 访问协作服务，切勿向公网直接开放 HTTP。
