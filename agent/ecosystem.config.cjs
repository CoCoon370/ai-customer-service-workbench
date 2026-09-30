module.exports = {
  apps: [
    {
      name: "workbench-agent-v2",
      cwd: "/root/apps/linglongzi-new-langgraph-templete-python-v2",
      script: "/bin/bash",
      args: "-lc 'set -a; source .env.v2; set +a; exec uv run uvicorn api.app:app --host 127.0.0.1 --port 2124'",
      interpreter: "none",
      out_file: "/var/log/ai-customer-service/workbench-v2/agent.stdout.log",
      error_file: "/var/log/ai-customer-service/workbench-v2/agent.stderr.log",
      merge_logs: false,
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 10,
      min_uptime: "10s",
      max_memory_restart: "768M",
      kill_timeout: 10000,
    },
  ],
};
