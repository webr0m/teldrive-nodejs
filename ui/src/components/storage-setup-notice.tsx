import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button, Modal } from "@heroui/react";
import { currentUserQueryOptions } from "@/auth/queries";
import { needsClientTour, useClientOnboarding } from "@/lib/client-onboarding";
import { storageSetupQuery, useStorageSetupNotice } from "@/lib/storage-setup";

export function StorageSetupNotice() {
  const { data: user } = useQuery(currentUserQueryOptions());
  const { request, show, dismiss } = useStorageSetupNotice();
  const tourOpen = useClientOnboarding((state) => state.tourOpen);
  const navigate = useNavigate();
  const announced = useRef<number | undefined>(undefined);
  const parentId = request?.userId === user?.userId ? request?.parentId : undefined;
  const status = useQuery({ ...storageSetupQuery(user?.userId ?? 0, parentId), enabled: !!user });
  const [otherDialog, setOtherDialog] = useState(true);
  useEffect(() => {
    const update = () =>
      setOtherDialog(
        Boolean(
          document.querySelector(
            '[role="dialog"]:not([data-storage-setup-dialog]), [role="alertdialog"]:not([data-storage-setup-dialog])',
          ),
        ),
      );
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!user || !status.data) return;
    if (status.data.configured && request?.userId === user.userId) dismiss();
    if (announced.current === user.userId) return;
    announced.current = user.userId;
    if (status.data.requiresChannel && !status.data.configured)
      show({ userId: user.userId, reason: "welcome" });
  }, [user?.userId, status.data, request?.userId, show, dismiss]);
  const pendingTour = !!user && needsClientTour(user.userId);
  const open =
    !!user && request?.userId === user.userId && !tourOpen && !pendingTour && !otherDialog;
  const go = (to: "/settings/channels" | "/settings/bots" | "/settings/help") => {
    dismiss();
    void navigate({ to });
  };
  return (
    <Modal.Backdrop
      isOpen={open}
      onOpenChange={(value) => {
        if (!value) dismiss();
      }}
      isDismissable
    >
      <Modal.Container size="sm" scroll="inside">
        <Modal.Dialog data-storage-setup-dialog>
          <Modal.Header>
            <Modal.Heading>Configura tu disco virtual de Telegram</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="space-y-4 text-sm">
            <p>
              Para guardar archivos en tu unidad necesitas configurar y seleccionar un{" "}
              <strong>canal privado de Telegram</strong>. Ese canal será tu disco virtual.
            </p>
            <p>
              Crea el canal privado en Telegram y selecciónalo en Configuración → Canales. En la web
              también puedes crear un canal privado desde esa sección.
            </p>
            <p>
              De forma <strong>opcional</strong>, puedes añadir bots con acceso al canal para
              mejorar la velocidad de carga y descarga. La mejora depende de Telegram, tu conexión y
              los límites del servidor; no necesitas bots para empezar.
            </p>
            {request?.reason === "upload" && (
              <p role="status">
                La subida no ha comenzado. Después de seleccionar el canal, vuelve a elegir los
                archivos. Si el destino es una carpeta compartida, su propietario debe configurar el
                canal.
              </p>
            )}
          </Modal.Body>
          <Modal.Footer className="flex-wrap">
            <Button variant="tertiary" onPress={dismiss}>
              Ahora no
            </Button>
            <Button variant="secondary" onPress={() => go("/settings/help")}>
              Abrir manual
            </Button>
            <Button variant="secondary" onPress={() => go("/settings/bots")}>
              Bots opcionales
            </Button>
            <Button variant="primary" onPress={() => go("/settings/channels")}>
              Configurar canal
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
