// Read-only connectivity check; never prints API keys, filenames or database URLs.
import { config } from '../src/config.mjs';
import { SupabaseStore } from '../src/supabase.mjs';
let store;
try {
  store = new SupabaseStore(config());
  console.log(JSON.stringify({ transport: 'https', files: store.list('files').length, users: store.list('users').length, channels: store.list('channels').length }));
} catch (error) { console.error(JSON.stringify({ status: 'failed', code: error.code || 'connection_error' })); process.exitCode = 1; }
finally { store?.close(); }
