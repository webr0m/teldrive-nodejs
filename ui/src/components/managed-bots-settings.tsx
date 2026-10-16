import { useState } from "react";
import { Button, Input, Spinner } from "@heroui/react";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { $api } from "@/api/client";
import { userMessage } from "@/api/errors";
import type { components } from "@/api/schema";
import { SettingsSection } from "@/components/settings-layout";
import { newIdempotencyKey } from "@/features/shared/idempotency";
import { t } from "@/lib/localization";

const selectClass =
  "w-full min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground";
export function ManagedBotsSettings({
  bots,
  onChanged,
}: {
  bots: components["schemas"]["BotSummary"][];
  onChanged: () => Promise<unknown>;
}) {
  const manager = $api.useQuery("get", "/v1/bots/manager");
  const channels = $api.useQuery("get", "/v1/channels", { params: { query: { limit: 200 } } });
  const select = $api.useMutation("post", "/v1/bots/manager");
  const clear = $api.useMutation("delete", "/v1/bots/manager");
  const create = $api.useMutation("post", "/v1/bots/managed");
  const check = $api.useMutation("post", "/v1/bots/managed/check-username");
  const [managerId, setManagerId] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [channelId, setChannelId] = useState("");
  const [available, setAvailable] = useState("");
  const [feedback, setFeedback] = useState<{ message: string; error?: boolean }>();
  const pending = create.isPending || select.isPending || clear.isPending || check.isPending;
  const chosenChannel =
    channelId || String(channels.data?.items.find((channel) => channel.selected)?.id || "");
  const normalized = username.trim().replace(/^@/, "").toLowerCase();
  const supported = manager.data?.supported !== false;
  const retry = manager.data?.pending.some((bot) => bot.username === normalized);
  const report = (error: unknown) => setFeedback({ message: userMessage(error), error: true });
  const refresh = async () => {
    await onChanged();
  };

  return (
    <SettingsSection
      title={t("Crear bots desde Teldrive")}
      description={t(
        "Crea un bot en tu cuenta de Telegram y úsalo en el canal privado que elijas.",
      )}
    >
      <div className="min-w-0 space-y-5 p-4 sm:p-5">
        {manager.isPending ? <Spinner aria-label={t("Cargando administrador de bots")} /> : null}
        {manager.isError && (
          <p role="alert" className="text-sm text-danger">
            {userMessage(manager.error)}
          </p>
        )}
        {!supported && (
          <p className="text-sm text-muted">
            {t(
              "La creación de bots reales requiere iniciar sesión en un servidor conectado a Telegram.",
            )}
          </p>
        )}
        <details open={!manager.data?.configured} className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {manager.data?.bot
              ? `${t("Bot administrador")}: @${manager.data.bot.username}`
              : t("Configurar bot administrador")}
          </summary>
          <div className="mt-3 space-y-3 text-sm">
            <p className="leading-relaxed text-muted">
              {t(
                "Una sola vez, crea o elige un bot tuyo en BotFather y activa Bot Management Mode en sus ajustes. Añádelo con su token en Vincular bots existentes y selecciónalo aquí. Después podrás crear nuevos bots desde esta pantalla.",
              )}
            </p>
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-accent underline"
            >
              {t("Abrir BotFather")}
            </a>
            <label className="block space-y-2">
              <span>{t("Tu bot administrador")}</span>
              <select
                aria-label={t("Tu bot administrador")}
                className={selectClass}
                value={managerId || String(manager.data?.bot?.id || "")}
                disabled={pending || !supported}
                onChange={(event) => setManagerId(event.target.value)}
              >
                <option value="">{t("Selecciona uno de tus bots activos")}</option>
                {bots
                  .filter((bot) => bot.enabled)
                  .map((bot) => (
                    <option key={bot.id} value={String(bot.id)}>
                      @{bot.username}
                    </option>
                  ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                isDisabled={pending || !supported || !(managerId || manager.data?.bot?.id)}
                isPending={select.isPending}
                onPress={async () => {
                  setFeedback(undefined);
                  try {
                    await select.mutateAsync({
                      params: { header: { "Idempotency-Key": newIdempotencyKey() } },
                      body: { botId: Number(managerId || manager.data?.bot?.id) },
                    });
                    await manager.refetch();
                    toast.success(t("Administrador verificado y guardado"));
                  } catch (error) {
                    report(error);
                  }
                }}
              >
                {t("Verificar y guardar administrador")}
              </Button>
              {manager.data?.configured && (
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={pending}
                  onPress={async () => {
                    try {
                      await clear.mutateAsync({});
                      setManagerId("");
                      await manager.refetch();
                    } catch (error) {
                      report(error);
                    }
                  }}
                >
                  {t("Quitar selección de administrador")}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted">
              {t(
                "Se comprueba que el administrador pertenece a tu cuenta y tiene Bot Management Mode activo. Quitar esta selección no elimina bots de Telegram.",
              )}
            </p>
          </div>
        </details>
        {!!manager.data?.pending.length && (
          <div className="space-y-2 rounded-lg border border-warning p-3">
            <p className="text-sm font-medium">{t("Bots creados con configuración pendiente")}</p>
            {manager.data.pending.map((bot) => (
              <div
                key={bot.botId}
                className="flex min-w-0 flex-wrap items-center justify-between gap-2"
              >
                <span className="break-all text-sm">@{bot.username}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={pending}
                  onPress={() => {
                    setName(bot.name);
                    setUsername(bot.username);
                    setChannelId(bot.channelId);
                    setAvailable("");
                    setFeedback(undefined);
                  }}
                >
                  {t("Preparar reintento")}
                </Button>
              </div>
            ))}
          </div>
        )}
        <form
          className="min-w-0 space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending || !manager.data?.configured || !chosenChannel) return;
            setFeedback(undefined);
            try {
              const result = await create.mutateAsync({
                params: { header: { "Idempotency-Key": newIdempotencyKey() } },
                body: { name: name.trim(), username: normalized, channelId: chosenChannel },
              });
              await refresh();
              if (result.setupPending)
                setFeedback({
                  message:
                    result.message ||
                    t(
                      "El bot existe en Telegram. Reintenta su configuración con el mismo usuario.",
                    ),
                  error: true,
                });
              else {
                toast.success(t("Bot creado y listo para transferencias"));
                setFeedback({
                  message: `@${result.bot.username} · ${t("Bot configurado en el canal elegido")}`,
                });
                setName("");
                setUsername("");
                setAvailable("");
              }
            } catch (error) {
              report(error);
            }
          }}
        >
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <label className="min-w-0 space-y-2 text-sm">
              <span>{t("Nombre del nuevo bot")}</span>
              <Input
                aria-label={t("Nombre del nuevo bot")}
                value={name}
                maxLength={64}
                required
                disabled={pending || !supported}
                onChange={(event) => setName(event.target.value)}
                placeholder="Teldrive archivos"
              />
            </label>
            <label className="min-w-0 space-y-2 text-sm">
              <span>{t("Usuario del nuevo bot")}</span>
              <Input
                aria-label={t("Usuario del nuevo bot")}
                value={username}
                maxLength={33}
                required
                disabled={pending || !supported}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setAvailable("");
                }}
                placeholder="mi_unidad_bot"
              />
            </label>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              isDisabled={pending || !supported || !normalized}
              isPending={check.isPending}
              onPress={async () => {
                setFeedback(undefined);
                setAvailable("");
                try {
                  const result = await check.mutateAsync({ body: { username: normalized } });
                  setAvailable(result.username);
                } catch (error) {
                  report(error);
                }
              }}
            >
              {t("Comprobar disponibilidad")}
            </Button>
            {available === normalized && !!available && (
              <p role="status" className="break-all text-xs text-success">
                @{available} · {t("Disponible")}
              </p>
            )}
          </div>
          <label className="block space-y-2 text-sm">
            <span>{t("Canal privado para este bot")}</span>
            <select
              aria-label={t("Canal privado para este bot")}
              className={selectClass}
              value={chosenChannel}
              required
              disabled={pending || channels.isPending || !supported}
              onChange={(event) => setChannelId(event.target.value)}
            >
              <option value="">{t("Selecciona un canal de tu unidad")}</option>
              {channels.data?.items.map((channel) => (
                <option key={channel.id} value={String(channel.id)}>
                  {channel.name || String(channel.id)}
                  {channel.selected ? ` · ${t("En uso")}` : ""}
                </option>
              ))}
            </select>
          </label>
          {channels.isError && (
            <p role="alert" className="text-sm text-danger">
              {userMessage(channels.error)}
            </p>
          )}
          {!channels.isPending && !channels.data?.items.length && (
            <Link to="/settings/channels" className="text-sm text-accent underline">
              {t("Configurar un canal de Telegram")}
            </Link>
          )}
          <p className="text-xs leading-relaxed text-muted">
            {t(
              "El bot pertenecerá a tu cuenta y podrá ser gestionado por el administrador elegido. Recibirá permisos de publicación, edición y eliminación en ese canal. Su token se guarda cifrado en el servidor y no se muestra. Telegram aplica sus propios límites de creación.",
            )}
          </p>
          <Button
            type="submit"
            className="w-full whitespace-normal sm:w-auto"
            isPending={create.isPending}
            isDisabled={
              pending ||
              !supported ||
              !manager.data?.configured ||
              !name.trim() ||
              !normalized ||
              !chosenChannel
            }
          >
            {retry ? t("Completar configuración del bot") : t("Crear bot y configurar canal")}
          </Button>
        </form>
        {feedback && (
          <p
            role={feedback.error ? "alert" : "status"}
            className={`break-words text-sm ${feedback.error ? "text-danger" : "text-success"}`}
          >
            {feedback.message}
          </p>
        )}
        <Link to="/settings/help" className="inline-block text-sm text-accent underline">
          {t("Abrir manual de bots y canales")}
        </Link>
      </div>
    </SettingsSection>
  );
}
