import { fail } from './core.mjs';

// A configured Telegram ID takes precedence over roles imported from another server.
export function isOwner(user, config) {
  return !!user && !user.disabled && !user.clientOnly && user.role === 'owner' &&
    (!config.ownerUserId || String(user.id) === String(config.ownerUserId));
}
export function requireOwner(user, config) {
  if (!isOwner(user, config)) fail(403, 'owner_required', 'Esta opción solo está disponible para el propietario.');
}
