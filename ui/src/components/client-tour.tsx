import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Modal } from "@heroui/react";
import { currentUserQueryOptions } from "@/auth/queries";
import { clientOnly } from "@/lib/client-runtime";
import { clientManual } from "@/lib/client-manual";
import { needsClientTour, rememberClientTour, useClientOnboarding } from "@/lib/client-onboarding";
export function repeatClientTour() {
  window.dispatchEvent(new Event("teldrive-client-tour"));
}
export function ClientTour() {
  const { data: user } = useQuery(currentUserQueryOptions());
  const { tourOpen: open, setTourOpen: setOpen } = useClientOnboarding();
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (user && needsClientTour(user.userId)) setOpen(true);
    const repeat = () => {
      setStep(0);
      setOpen(true);
    };
    window.addEventListener("teldrive-client-tour", repeat);
    return () => {
      window.removeEventListener("teldrive-client-tour", repeat);
      setOpen(false);
    };
  }, [user?.userId, setOpen]);
  const close = () => {
    if (user) rememberClientTour(user.userId);
    setOpen(false);
  };
  const page = clientManual[step];
  if (!clientOnly) return null;
  return (
    <Modal.Backdrop
      isOpen={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
      isDismissable
      data-client-tour
    >
      <Modal.Container size="sm" scroll="inside">
        <Modal.Dialog>
          <Modal.Header>
            <div>
              <p className="text-xs text-muted">
                Teldrive Cliente · {step + 1} de {clientManual.length}
              </p>
              <Modal.Heading>{page.title}</Modal.Heading>
            </div>
          </Modal.Header>
          <Modal.Body className="space-y-4">
            <p className="font-medium">{page.summary}</p>
            <ul className="list-disc space-y-3 pl-5 text-sm text-muted">
              {page.steps.slice(0, 3).map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
            <p className="text-xs text-muted">
              Encontrarás todos los detalles en Configuración → Ayuda y manual.
            </p>
          </Modal.Body>
          <Modal.Footer className="flex-wrap">
            <Button variant="tertiary" onPress={close}>
              Omitir recorrido
            </Button>
            <Button
              variant="secondary"
              isDisabled={step === 0}
              onPress={() => setStep((value) => value - 1)}
            >
              Anterior
            </Button>
            <Button
              onPress={() =>
                step === clientManual.length - 1 ? close() : setStep((value) => value + 1)
              }
            >
              {step === clientManual.length - 1 ? "Empezar" : "Siguiente"}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
