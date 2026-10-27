// PM2 process file:  pm2 start deploy/ecosystem.config.js && pm2 save && pm2 startup
// Keep instances at 1 – the app uses a single SQLite file and runs its own scheduler.
module.exports = {
  apps: [{
    name: 'jeta-crm',
    script: 'server.js',
    cwd: __dirname + '/..',
    node_args: '--no-warnings',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '400M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      HOST: '127.0.0.1',
      DB_PATH: '/var/lib/jeta-crm/jeta-crm.db',
      BACKUP_DIR: '/var/backups/jeta-crm',
      TRUST_PROXY: 'true',
    },
  }],
};
