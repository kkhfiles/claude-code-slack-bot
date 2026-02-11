module.exports = {
  apps: [{
    name: 'claude-slack-bot',
    script: 'dist/index.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    watch: false,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
