import { createApp } from './app.js';

const { app, config, close } = createApp();

const server = app.listen(config.port, config.host, () => {
  console.log(`Workspace Launch listening on http://${config.host}:${config.port}${config.basePath || '/'}`);
  console.log(`Environment: ${config.nodeEnv} | static: client/dist | db: ${config.dbPath}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down.`);
  server.close(async () => {
    await close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
