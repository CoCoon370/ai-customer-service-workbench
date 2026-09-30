module.exports = {
  apps: [
    {
      name: "workbench-web-v2",
      cwd: "/root/apps/linglongzi-agent-chat-ui-v2",
      script: "/bin/bash",
      args: "-lc 'set -a; source .env.v2; set +a; exec pnpm start --hostname 0.0.0.0 --port 3100'",
      interpreter: "none",
      out_file: "/var/log/ai-customer-service/workbench-v2/web.stdout.log",
      error_file: "/var/log/ai-customer-service/workbench-v2/web.stderr.log",
      merge_logs: false,
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 10,
      min_uptime: "10s",
      max_memory_restart: "1024M",
      kill_timeout: 10000,
      env: { NODE_ENV: "production" },
    },
  ],
};
