type BotIdentity = { id: number | string; name?: string | null; username?: string | null };

export function botName(bot: BotIdentity) {
  return bot.name?.trim() || "Bot sin nombre";
}

export function botAlias(bot: BotIdentity) {
  const alias = bot.username?.trim().replace(/^@+/, "");
  return alias ? `@${alias}` : "Sin alias";
}

export function botLabel(bot: BotIdentity) {
  return `${botName(bot)} — ${botAlias(bot)} — ID: ${bot.id}`;
}
