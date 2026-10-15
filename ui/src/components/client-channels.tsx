import { Button, Chip } from "@heroui/react";
import { useState } from "react";
import { toast } from "sonner";
import { $api } from "@/api/client";
import { userMessage } from "@/api/errors";
import { getQueryClient } from "@/lib/queryClient";
import { newIdempotencyKey } from "@/features/shared/idempotency";
import { SettingsPageHeader, SettingsSection } from "./settings-layout";

export function ClientChannels() {
  const query = $api.useSuspenseQuery("get", "/v1/channels", { params: { query: { limit: 200 } } });
  const discovered = $api.useQuery(
    "get",
    "/v1/channels/discover",
    {},
    { enabled: false, retry: false },
  );
  const sync = $api.useMutation("post", "/v1/channels/sync");
  const select = $api.useMutation("post", "/v1/channels/{channelId}/select");
  const [pendingId, setPendingId] = useState<number>();
  const channels = [
    ...query.data.items,
    ...(discovered.data ?? []).filter(
      (item) => !query.data.items.some((saved) => saved.id === item.id),
    ),
  ];
  const choose = async (channelId: number) => {
    setPendingId(channelId);
    try {
      if (!query.data.items.some((channel) => channel.id === channelId))
        await sync.mutateAsync({
          params: { header: { "Idempotency-Key": newIdempotencyKey() } },
          body: { channelIds: [channelId] },
        });
      await select.mutateAsync({ params: { path: { channelId } } });
      await getQueryClient().invalidateQueries({
        queryKey: $api.queryOptions("get", "/v1/channels").queryKey,
      });
      await getQueryClient().invalidateQueries({ queryKey: ["storage-setup"] });
      toast.success("Canal seleccionado para las nuevas subidas");
    } catch (error) {
      toast.error("No se pudo seleccionar el canal", { description: userMessage(error) });
    } finally {
      setPendingId(undefined);
    }
  };
  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title="Canales de Telegram"
        description="Elige el canal que tu unidad usará para guardar las nuevas subidas. Los archivos existentes siguen en sus canales actuales."
      />
      <SettingsSection
        title="Canal de la unidad"
        description="La cuenta de Telegram y sus bots deben tener acceso al canal. Esta preferencia pertenece a tu cuenta."
      >
        <div className="divide-y divide-border">
          {channels.map((channel) => (
            <div key={channel.id} className="flex min-w-0 flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium">{channel.name}</p>
                <p className="mt-1 break-all text-xs text-muted">ID {channel.id}</p>
              </div>
              {"selected" in channel && channel.selected ? (
                <Chip color="success" variant="tertiary">
                  En uso
                </Chip>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={pendingId !== undefined}
                  onPress={() => void choose(channel.id)}
                >
                  {pendingId === channel.id ? "Guardando…" : "Usar canal"}
                </Button>
              )}
            </div>
          ))}
          {!channels.length && (
            <p className="p-4 text-sm text-muted">
              No hay canales configurados. Busca los canales disponibles de tu cuenta de Telegram.
            </p>
          )}
        </div>
        <div className="space-y-3 border-t border-border p-4">
          <Button
            variant="secondary"
            className="w-full whitespace-normal"
            isDisabled={discovered.isFetching || pendingId !== undefined}
            onPress={() => void discovered.refetch()}
          >
            {discovered.isFetching ? "Buscando…" : "Buscar canales en Telegram"}
          </Button>
          {discovered.isError && (
            <p role="alert" className="text-sm text-danger">
              {userMessage(discovered.error)}
            </p>
          )}
          {discovered.isSuccess && !discovered.data.length && (
            <p role="status" className="text-sm text-muted">
              Telegram no devolvió canales disponibles. Comprueba tus permisos de administrador.
            </p>
          )}
          <p className="text-xs leading-relaxed text-muted">
            Seleccionar otro canal no mueve ni elimina archivos. Si una subida ya comenzó,
            conservará su canal original. Puedes administrar tus bots desde Configuración → Bots.
          </p>
        </div>
      </SettingsSection>
    </div>
  );
}
