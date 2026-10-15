import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@heroui/react";
import { toast } from "sonner";
import { apiFetch } from "@/api/client";
import { nativeClient } from "@/lib/client-runtime";
import { publicHttps } from "@/lib/mobile-ads-config";
import { cleanClientCache } from "@/lib/mobile";
import { reviewAdvertisingPrivacy } from "@/components/mobile-advertising";
import { SettingsPageHeader, SettingsSection } from "@/components/settings-layout";
export const Route = createFileRoute("/_settings/settings/privacy")({ component: Privacy });
function Privacy() {
  const [busy, setBusy] = useState(false);
  const config = useQuery({
    queryKey: ["mobile", "config"],
    queryFn: async () => (await apiFetch("/v1/mobile/config")).json(),
  });
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast.error(String((error as Error).message || error));
    } finally {
      setBusy(false);
    }
  };
  const open = async (url: string) => {
    if (!publicHttps(url)) return;
    if (nativeClient) await (await import("@capacitor/browser")).Browser.open({ url });
    else window.open(url, "_blank", "noopener,noreferrer");
  };
  return (
    <div className="space-y-5">
      <SettingsPageHeader
        title="Privacidad y publicidad"
        description="Opciones de este dispositivo y acceso a la información del editor."
      />
      <SettingsSection
        title="Consentimiento publicitario"
        description="AdMob solo solicita anuncios cuando el sistema de consentimiento lo permite. Esta edición solicita anuncios no personalizados y no pide permiso de seguimiento de iOS."
      >
        <div className="space-y-3 p-5">
          <Button
            isDisabled={!nativeClient || busy || !config.data?.adsConfigUrl}
            onPress={() => void run(reviewAdvertisingPrivacy)}
          >
            Revisar consentimiento de anuncios
          </Button>
          <p className="text-xs text-muted">
            La disponibilidad del formulario depende de tu región y de la configuración de
            publicidad del editor. Los banners propios se identifican como publicidad y se pueden
            cerrar.
          </p>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Archivos temporales"
        description="Las descargas se preparan en la caché privada antes de abrir el guardado del sistema. Las copias de más de un día se limpian al iniciar la app."
      >
        <div className="p-5">
          <Button
            variant="secondary"
            isDisabled={!nativeClient || busy}
            onPress={() =>
              void run(async () => {
                const count = await cleanClientCache();
                toast.success(`${count} archivos temporales eliminados`);
              })
            }
          >
            Limpiar caché de descargas
          </Button>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Cuenta y datos"
        description="Vincular Google añade una forma de entrar a la misma cuenta de Telegram. No se combinan unidades ni se envían nombres de archivos a la publicidad."
      >
        <div className="space-y-3 p-5">
          <p className="text-sm">
            Puedes desvincular Google desde Cuenta después de autenticarte con Telegram. Eso revoca
            las sesiones móviles de Google. Cerrar sesión elimina la credencial guardada en este
            dispositivo. Tus archivos de Teldrive y tu cuenta de Telegram se administran por
            separado.
          </p>
          {publicHttps(config.data?.privacyUrl) && (
            <Button variant="secondary" onPress={() => void open(config.data.privacyUrl)}>
              Política de privacidad del editor
            </Button>
          )}
          {publicHttps(config.data?.supportUrl) && (
            <Button variant="secondary" onPress={() => void open(config.data.supportUrl)}>
              Soporte y solicitudes sobre datos
            </Button>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
