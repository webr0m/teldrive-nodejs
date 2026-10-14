// CommonJS startup file required by cPanel/Passenger; application modules are ESM.
try { require('node:process').loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
import('./src/server.mjs').then(({ start }) => start()).catch((error) => {
  console.error(JSON.stringify({ level: 'error', event: 'startup_failed', message: error.message }));
  process.exitCode = 1;
});
