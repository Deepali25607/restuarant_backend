// PM2 process manager config for the backend.
// Usage on the server:
//   npm ci --omit=dev
//   npm run build            # prisma generate + db push
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup  # survive reboots
//
// Env values live in .env (loaded by dotenv in server.js) — this file only
// controls how PM2 runs the process, not secrets.
module.exports = {
  apps: [
    {
      name: 'ordernow-api',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
