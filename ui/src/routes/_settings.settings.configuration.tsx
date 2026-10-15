import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button, Spinner } from "@heroui/react";
import { toast } from "sonner";
import { apiFetch } from "@/api/client";
import { useCurrentUser } from "@/auth/use-current-user";
import { SettingsPageHeader, SettingsSection } from "@/components/settings-layout";

type Configuration = {
  enabled: boolean;
  toml: string;
  revision: string;
  restartRequired: boolean;
  restartAvailable: boolean;
  backups: { id: string; createdAt: string }[];
};
type Validation = {
  changed: string[];
  ignored: string[];
  databaseChanged: boolean;
  connectionTested: false;
};
export const Route = createFileRoute("/_settings/settings/configuration")({
  component: ServerConfiguration,
});

function ServerConfiguration() {
  const queryClient = useQueryClient();
  const user = useCurrentUser();
  const allowed = user.data.capabilities.includes("system.configureServer");
  const query = useQuery({
    queryKey: ["server-configuration"],
    enabled: allowed,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () =>
      (await apiFetch("/v1/admin/configuration")).json() as Promise<Configuration>,
  });
  const [toml, setToml] = useState("");
  const [validation, setValidation] = useState<Validation>();
  const [confirmDatabaseChange, setConfirmDatabaseChange] = useState(false);
  const [discardUnsupported, setDiscardUnsupported] = useState(false);
  const [backupId, setBackupId] = useState("");
  const [confirmRestore, setConfirmRestore] = useState(false);
  const edit = (value: string) => {
    setToml(value);
    setValidation(undefined);
    setConfirmDatabaseChange(false);
    setDiscardUnsupported(false);
  };
  useEffect(() => {
    if (query.data) edit(query.data.toml);
  }, [query.data]);
  const action = useMutation({
    mutationFn: async (name: "validate" | "save" | "restore" | "restart") => {
      const response = await apiFetch(`/v1/admin/configuration/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Teldrive-Config": "1" },
        body: JSON.stringify({
          toml,
          revision: query.data?.revision,
          confirmDatabaseChange: name === "restore" ? confirmRestore : confirmDatabaseChange,
          discardUnsupported,
          backupId,
        }),
      });
      return { name, data: await response.json() };
    },
    onSuccess: ({ name, data }) => {
      if (name === "validate") setValidation(data as Validation);
      else if (name === "restart")
        toast.success("Reinicio solicitado. Vuelve a cargar la página dentro de unos segundos.");
      else {
        toast.success("Configuración guardada para el próximo reinicio");
        setBackupId("");
        setConfirmRestore(false);
        // Use the redacted response immediately, even if a later request fails.
        queryClient.setQueryData(["server-configuration"], data as Configuration);
      }
    },
    onError: (error) => toast.error(error.message),
  });
  if (!allowed) return <p>Esta opción solo está disponible para el propietario.</p>;
  if (query.isPending) return <Spinner aria-label="Cargando configuración" />;
  if (query.error) return <p role="alert">{query.error.message}</p>;
  const current = query.data;
  if (!current?.enabled) return <p>La edición del servidor está desactivada en este entorno.</p>;
  const busy = action.isPending;
  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="Configuración del servidor"
        description="Importa o edita los parámetros del TOML desde tu sesión de propietario. Los secretos existentes se ocultan y se conservan al guardar."
      />
      {current.restartRequired && (
        <div role="status" className="rounded-xl border border-warning p-4 text-sm">
          Hay cambios guardados pendientes de reinicio. La aplicación sigue usando la configuración
          anterior.
        </div>
      )}
      <SettingsSection
        title="TOML privado"
        description="Se guarda en un archivo privado del hosting, con respaldo y escritura atómica. Tiene prioridad sobre el TOML original y las variables de entorno. Los campos omitidos conservan su valor; usa una cadena vacía para borrar uno."
      >
        <div className="space-y-4 p-5">
          <label className="block space-y-2 text-sm">
            <span>Importar un archivo TOML (máximo 256 KiB)</span>
            <input
              type="file"
              accept=".toml,text/plain"
              disabled={busy}
              className="block max-w-full"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                if (file.size > 262144) {
                  toast.error("El archivo supera 256 KiB");
                  return;
                }
                try {
                  edit(await file.text());
                } catch {
                  toast.error("No se pudo leer el archivo");
                }
              }}
            />
          </label>
          <label className="block space-y-2 text-sm">
            <span>Configuración TOML</span>
            <textarea
              aria-label="Configuración TOML"
              value={toml}
              onChange={(event) => edit(event.target.value)}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              className="min-h-96 w-full rounded-xl border border-border bg-background p-4 font-mono text-xs"
            />
          </label>
          <p className="text-sm text-muted">
            Conserva <code>__TELDRIVE_KEEP_SECRET__</code> para mantener una contraseña. Las claves
            de cifrado, la identidad del propietario y los parámetros de arranque se administran
            desde el hosting.
          </p>
          <p className="text-sm text-muted">
            Validar comprueba sintaxis y parámetros. No prueba la conexión ni migra archivos o
            tablas. Un cambio de base de datos requiere un destino preparado y un respaldo previo.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" isDisabled={busy} onPress={() => action.mutate("validate")}>
              Validar TOML
            </Button>
            <Button variant="tertiary" isDisabled={busy} onPress={() => void query.refetch()}>
              Descartar edición y recargar
            </Button>
          </div>
          {validation && (
            <div role="status" className="space-y-3 rounded-xl border border-border p-4 text-sm">
              <p>
                Validación correcta. Parámetros que cambian:{" "}
                {validation.changed.join(", ") || "ninguno"}.
              </p>
              {!!validation.ignored.length && (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={discardUnsupported}
                    onChange={(event) => setDiscardUnsupported(event.target.checked)}
                  />
                  <span>
                    Omitir estas opciones sin soporte en Node: {validation.ignored.join(", ")}
                  </span>
                </label>
              )}
              {validation.databaseChanged && (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={confirmDatabaseChange}
                    onChange={(event) => setConfirmDatabaseChange(event.target.checked)}
                  />
                  <span>
                    Confirmo que preparé el destino y el respaldo. Guardar no copia ni migra la base
                    de datos.
                  </span>
                </label>
              )}
            </div>
          )}
          <Button
            variant="primary"
            isDisabled={
              busy ||
              !validation ||
              (!!validation.ignored.length && !discardUnsupported) ||
              (validation.databaseChanged && !confirmDatabaseChange)
            }
            onPress={() => action.mutate("save")}
          >
            Guardar para el próximo reinicio
          </Button>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Aplicar y recuperar"
        description="Reiniciar puede interrumpir transferencias. Los respaldos recuperan la configuración anterior; no restauran datos ni archivos de una base de datos."
      >
        <div className="space-y-4 p-5 text-sm">
          {current.restartAvailable ? (
            <Button
              variant="secondary"
              isDisabled={busy || !current.restartRequired}
              onPress={() => action.mutate("restart")}
            >
              Reiniciar aplicación
            </Button>
          ) : (
            <p>Reinicia Node desde el panel de tu hosting para aplicar los cambios.</p>
          )}
          <label className="block space-y-2">
            <span>Respaldo de configuración</span>
            <select
              aria-label="Respaldo de configuración"
              value={backupId}
              onChange={(event) => {
                setBackupId(event.target.value);
                setConfirmRestore(false);
              }}
              className="block max-w-full rounded-lg border border-border bg-background p-2"
            >
              <option value="">Selecciona un respaldo</option>
              {current.backups.map((backup) => (
                <option key={backup.id} value={backup.id}>
                  {new Date(backup.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          {!!backupId && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={confirmRestore}
                onChange={(event) => setConfirmRestore(event.target.checked)}
              />
              <span>
                Restaurar puede cambiar la conexión a la base de datos. Confirmo que tengo el
                respaldo de los datos.
              </span>
            </label>
          )}
          <Button
            variant="secondary"
            isDisabled={busy || !backupId || !confirmRestore}
            onPress={() => action.mutate("restore")}
          >
            Restaurar configuración seleccionada
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
}
