import { createRequire } from 'node:module';
import { fail, now, Locks } from './core.mjs';
const { Api, utils } = createRequire(import.meta.url)('teleproto');

function username(value) {
  if (typeof value !== 'string') fail(422, 'bot_username_invalid', 'Introduce un usuario de 5 a 32 caracteres terminado en bot.');
  const result = value.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{2,29}bot$/.test(result)) fail(422, 'bot_username_invalid', 'El usuario debe tener entre 5 y 32 letras, números o guiones bajos y terminar en bot.');
  return result;
}
export function managedBotError(error) {
  if (error.status) throw error;
  const code = error.errorMessage || '';
  const errors = {
    USERNAME_OCCUPIED: [409, 'bot_username_occupied', 'Ese usuario ya está ocupado. Elige otro.'],
    USERNAME_INVALID: [422, 'bot_username_invalid', 'El usuario del bot no es válido.'],
    USERNAME_SUFFIX_MISSING: [422, 'bot_username_invalid', 'El usuario debe terminar en bot.'],
    NAME_INVALID: [422, 'bot_name_invalid', 'Introduce un nombre de entre 1 y 64 caracteres.'],
    BOT_CREATE_LIMIT_EXCEEDED: [409, 'bot_creation_limit', 'Tu cuenta alcanzó el límite de bots permitido por Telegram.'],
    MANAGER_PERMISSION_MISSING: [422, 'bot_manager_mode_required', 'Activa Bot Management Mode para el administrador en BotFather.'],
    MANAGER_INVALID: [422, 'bot_manager_invalid', 'El bot administrador ya no está disponible. Configúralo de nuevo.'],
    BOT_INVALID: [409, 'bot_manager_mismatch', 'Este bot no pertenece al administrador elegido. Utiliza su administrador original o añade su token.'],
    CHAT_ADMIN_REQUIRED: [403, 'bot_channel_permission', 'Tu cuenta necesita permisos para añadir administradores al canal.'],
    USER_ADMIN_INVALID: [403, 'bot_channel_permission', 'Telegram rechazó los permisos del bot en el canal.'],
    BOTS_TOO_MUCH: [409, 'bot_channel_limit', 'El canal alcanzó el límite de bots permitido por Telegram.'],
  };
  if (errors[code]) fail(...errors[code]);
  if (/FLOOD|SLOWMODE/.test(code)) fail(429, 'bot_rate_limit', `Telegram solicita esperar ${Number(error.seconds) || 'unos'} segundos antes de reintentar.`);
  fail(503, 'bot_telegram_unavailable', 'No se pudo completar la operación con Telegram. Reintenta más tarde.');
}

export class ManagedBots {
  constructor(store, telegram) { this.store = store; this.telegram = telegram; this.locks = new Locks(); }
  manager(userId) {
    const saved = this.store.get('settings', `bot-manager:${userId}`), bot = saved && this.store.get('bots', saved.botId);
    return bot?.ownerId === userId && bot.enabled ? bot : undefined;
  }
  read(userId) {
    const bot = this.manager(userId);
    const pending = this.store.list('settings', userId).filter(record => record.kind === 'managed-bot' && record.state !== 'ready')
      .map(({ botId, name, username, channelId }) => ({ botId, name, username, channelId }));
    return { configured: !!bot, pending, ...(bot ? { bot: this.telegram.botSummary(bot) } : {}) };
  }
  async select(userId, botId) {
    if (!/^[1-9][0-9]{0,19}$/.test(String(botId ?? ''))) fail(422, 'bot_manager_invalid', 'Elige uno de tus bots.');
    return this.locks.run(userId, async () => {
      const bot = this.store.get('bots', String(botId));
      if (!bot?.enabled || bot.ownerId !== userId) fail(404, 'bot_manager_not_found', 'El administrador debe ser uno de tus bots activos.');
      try {
        await this.telegram.withClient(userId, async client => {
          const owned = await client.invoke(new Api.bots.GetAdminedBots());
          if (!owned.some(candidate => String(candidate.id) === bot.id)) fail(403, 'bot_manager_not_owned', 'El bot administrador debe pertenecer a tu cuenta de Telegram.');
        });
        await this.checkManager(bot);
        this.store.put('settings', { id: `bot-manager:${userId}`, kind: 'bot-manager', ownerId: userId, botId: bot.id, updatedAt: now() });
        return this.read(userId);
      } catch (error) { managedBotError(error); }
    });
  }
  async clear(userId) { return this.locks.run(userId, () => { this.store.delete('settings', `bot-manager:${userId}`); return this.read(userId); }); }
  async checkManager(bot) {
    await this.telegram.withBot(bot, async client => {
      const identity = await client.getMe();
      if (String(identity.id) !== bot.id || !identity.botCanManageBots) fail(422, 'bot_manager_mode_required', 'Activa Bot Management Mode para el administrador en BotFather.');
    });
  }
  async checkUsername(userId, value) {
    const checked = username(value);
    try {
      await this.telegram.withClient(userId, async client => {
        if (!await client.invoke(new Api.bots.CheckUsername({ username: checked }))) fail(409, 'bot_username_occupied', 'Ese usuario ya está ocupado.');
      });
      return { username: checked, available: true };
    } catch (error) { managedBotError(error); }
  }
  async create(userId, input) {
    const checked = username(input.username), displayName = typeof input.name === 'string' ? input.name.trim() : '';
    if (!displayName || [...displayName].length > 64 || /[\x00-\x1f\x7f]/.test(displayName)) fail(422, 'bot_name_invalid', 'Introduce un nombre de entre 1 y 64 caracteres.');
    const channelId = String(input.channelId ?? ''), channel = this.store.list('channels', userId).find(candidate => candidate.id === channelId);
    if (!channel) fail(404, 'bot_channel_not_found', 'Selecciona un canal privado configurado en tu cuenta.');
    return this.locks.run(userId, async () => {
      const manager = this.manager(userId);
      if (!manager) fail(422, 'bot_manager_required', 'Configura primero un bot administrador.');
      const recordId = `managed-bot:${userId}:${checked}`;
      let created;
      try {
        await this.checkManager(manager);
        // A lost createBot response can be recovered using the bots Telegram
        // says this user owns; never create another bot merely to retry setup.
        created = await this.telegram.withClient(userId, async client => {
          const owned = await client.invoke(new Api.bots.GetAdminedBots());
          const administrator = owned.find(bot => String(bot.id) === manager.id);
          if (!administrator) fail(403, 'bot_manager_not_owned', 'El administrador ya no pertenece a tu cuenta.');
          const entity = await this.telegram.entity(client, channelId);
          if (entity.username || entity.broadcast === false) fail(422, 'bot_private_channel_required', 'Elige un canal privado de Telegram como unidad.');
          if (!entity.creator && !entity.adminRights?.addAdmins) fail(403, 'bot_channel_permission', 'Tu cuenta necesita permisos para añadir administradores al canal.');
          const existing = owned.find(bot => bot.username?.toLowerCase() === checked);
          if (existing) return existing;
          if (!await client.invoke(new Api.bots.CheckUsername({ username: checked }))) fail(409, 'bot_username_occupied', 'Ese usuario ya está ocupado.');
          return client.invoke(new Api.bots.CreateBot({ name: displayName, username: checked, managerId: utils.getInputUser(administrator) }));
        });
        const botId = String(created.id);
        const record = { id: recordId, kind: 'managed-bot', ownerId: userId, botId, name: displayName, username: checked, managerId: manager.id, channelId, state: 'created', updatedAt: now() };
        this.store.put('settings', record);
        const exported = await this.telegram.withBot(manager, async client => client.invoke(new Api.bots.ExportBotToken({ bot: utils.getInputUser(await client.getInputEntity(checked)), revoke: false })));
        if (typeof exported.token !== 'string' || exported.token.split(':')[0] !== botId) fail(503, 'bot_token_invalid', 'Telegram no devolvió una credencial válida para el bot.');
        const bot = await this.telegram.registerBot(userId, exported.token, [channelId]);
        record.state = 'ready'; this.store.put('settings', record);
        return { bot, channelId, setupPending: false };
      } catch (error) {
        if (!created) managedBotError(error);
        // Telegram has already created the account. Report that fact without
        // leaking its token or disguising a partial setup as a failed creation.
        let message;
        try { managedBotError(error); } catch (safe) { message = safe.message; }
        return { bot: { id: Number(created.id), username: checked, enabled: false, createdAt: now() }, channelId, setupPending: true,
          message: `${message} El bot ya existe en Telegram. Reintenta con el mismo usuario para completar su configuración.` };
      }
    });
  }
}
