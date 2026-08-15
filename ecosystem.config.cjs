module.exports = {
  apps: [
    {
      name: "open-grokbot-console",
      cwd: "/home/domwsl/dev/open-grokbot",
      script: "apps/console/pm2-launcher.mjs",
      env: {
        PORT: "8801",
        OPEN_GROKBOT_DATA_DIR: "/home/domwsl/dev/open-grokbot/.open-grokbot-data",
        LLM_PROVIDER: "anthropic",
        // Dummy key — the :4100 claude-oauth-proxy strips it and injects the
        // plan-tier OAuth token itself (never put a real API key here).
        ANTHROPIC_API_KEY: "oauth",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:4100",
        ANTHROPIC_MODEL: "claude-sonnet-4-6",
      },
    },
  ],
};
