import { Button, Label, NumberField, Spinner } from "@heroui/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiFetch } from "@/api/client";
import { useCurrentUser } from "@/auth/use-current-user";
import { SettingsPageHeader, SettingsRow, SettingsSection } from "@/components/settings-layout";
import { t } from "@/lib/localization";

type Limits = {
  values: Record<string, number>;
  definitions: Record<string, { label: string; min: number; max: number; env: string }>;
};
export const Route = createFileRoute("/_settings/settings/server")({ component: ServerSettings });
function ServerSettings() {
  const user = useCurrentUser();
  const allowed = user.data.capabilities.includes("system.configureServer");
  const query = useQuery({ queryKey: ["server-limits"], enabled: allowed, queryFn: async () => (await apiFetch("/v1/admin/settings")).json() as Promise<Limits> });
  const [values, setValues] = useState<Record<string, number>>({});
  useEffect(() => { if (query.data) setValues(query.data.values); }, [query.data]);
  const update = useMutation({ mutationFn: async () => (await apiFetch("/v1/admin/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) })).json(), onSuccess: () => { toast.success(t("Configuración guardada")); void query.refetch(); }, onError: (error) => toast.error(String(error)) });
  if (!allowed) return <p>{t("Esta opción solo está disponible para el propietario.")}</p>;
  return <div className="space-y-6">
    <SettingsPageHeader title={t("Límites del servidor")} description={t("Ajusta los recursos al servidor actual. Los cambios se guardan y se aplican a las nuevas transferencias.")} actions={<Button variant="primary" isDisabled={update.isPending || !query.data} onPress={() => update.mutate()}>{t("Guardar configuración")}</Button>} />
    <SettingsSection title={t("Recursos y transferencias")} description={t("Las cargas iniciadas conservan su tamaño de fragmento para poder reanudarse.")}>
      {query.isPending ? <div className="flex justify-center p-8"><Spinner /></div> : query.error ? <p className="p-5">{String(query.error)}</p> : Object.entries(query.data?.definitions || {}).map(([key, definition]) => <SettingsRow key={key} label={t(definition.label)} description={`${definition.min.toLocaleString()} – ${definition.max.toLocaleString()}`}>
        <NumberField aria-label={definition.label} value={values[key] ?? 0} minValue={definition.min} maxValue={definition.max} onChange={value => setValues(old => ({ ...old, [key]: value ?? definition.min }))}>
          <Label className="sr-only">{t(definition.label)}</Label><NumberField.Group><NumberField.DecrementButton /><NumberField.Input /><NumberField.IncrementButton /></NumberField.Group>
        </NumberField>
      </SettingsRow>)}
    </SettingsSection>
  </div>;
}
