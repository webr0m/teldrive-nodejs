import { readFileSync } from 'node:fs';
export function pgOptions(connectionString) {
  const url = new URL(connectionString);
  if (url.hostname.endsWith('.supabase.com') || url.hostname.endsWith('.supabase.co')) {
    const ca = ['2021', '2025'].map(year => readFileSync(new URL(`../certs/supabase-prod-${year}.crt`, import.meta.url), 'utf8')).join('\n');
    // Do not let connection-string parsing replace the explicit verified CA set.
    url.searchParams.delete('sslmode'); url.searchParams.delete('sslrootcert');
    return { connectionString: url.href, ssl: { ca, rejectUnauthorized: true } };
  }
  return { connectionString };
}
