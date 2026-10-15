import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/api/client";
import { nativeClient } from "@/lib/client-runtime";
import { googleClientLogin } from "@/lib/google-client";
import { SettingsSection } from "./settings-layout";
export function GoogleAccount() {
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  const account = useQuery({
    queryKey: ["mobile", "google-account"],
    queryFn: async () =>
      (await apiFetch("/v1/mobile/account")).json() as Promise<{
        enabled: boolean;
        linked: boolean;
        email?: string;
      }>,
    retry: false,
  });
  const run = async (remove: boolean) => {
    setBusy(true);
    controller.current = new AbortController();
    try {
      if (remove) await apiFetch("/v1/mobile/account/google", { method: "DELETE" });
      else await googleClientLogin(true, controller.current.signal);
      await account.refetch();
      toast.success(
        remove
          ? "Google desvinculado. Sus sesiones móviles se cerraron."
          : "Google vinculado con tu cuenta de Telegram",
      );
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        toast.error(String((error as Error).message || error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection
      title="Google y Telegram"
      description="Vincula explícitamente tus identidades después de iniciar sesión con Telegram. Google no sustituye la cuenta que almacena tus archivos."
    >
      <div className="space-y-3 p-5">
        <p className="text-sm">
          {account.data?.linked
            ? `Google vinculado: ${account.data.email}`
            : "Todavía no hay una cuenta de Google vinculada."}
        </p>
        {!account.data?.enabled && (
          <p className="text-sm text-muted">
            El editor debe configurar OAuth de Google en el servidor para habilitar el acceso.
          </p>
        )}
        <Button
          isDisabled={busy || !nativeClient || !account.data?.enabled}
          onPress={() => void run(Boolean(account.data?.linked))}
        >
          {busy
            ? "Esperando verificación…"
            : account.data?.linked
              ? "Desvincular Google"
              : "Vincular Google"}
        </Button>
        {busy && (
          <Button variant="tertiary" onPress={() => controller.current?.abort()}>
            Cancelar
          </Button>
        )}
        <p className="text-xs text-muted">
          Para vincular o desvincular se requiere un acceso con Telegram de los últimos diez
          minutos. Si hace falta, vuelve a entrar con Telegram.
        </p>
      </div>
    </SettingsSection>
  );
}
