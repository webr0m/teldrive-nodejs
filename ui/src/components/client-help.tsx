import { useState } from "react";
import { Button, Input } from "@heroui/react";
import { clientManual } from "@/lib/client-manual";
import { clientOnly } from "@/lib/client-runtime";
import { repeatClientTour } from "@/components/client-tour";
import { SettingsPageHeader } from "@/components/settings-layout";
export function ClientHelp({ tour = true }: { tour?: boolean }) {
  const [search, setSearch] = useState("");
  const chapters = clientManual.filter((chapter) =>
    `${chapter.title} ${chapter.summary} ${chapter.steps.join(" ")}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <div className="space-y-5">
      <SettingsPageHeader
        title="Ayuda y manual"
        description="Manual incluido en la aplicación. Puedes consultarlo sin abrir un sitio externo."
        actions={
          clientOnly && tour ? (
            <Button onPress={repeatClientTour}>Repetir recorrido</Button>
          ) : undefined
        }
      />
      <Input
        aria-label="Buscar en el manual"
        placeholder="Buscar en el manual"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {chapters.map((chapter) => (
        <details
          key={chapter.id}
          open={Boolean(search.trim())}
          className="rounded-xl border border-border bg-surface p-4"
        >
          <summary className="cursor-pointer font-medium">{chapter.title}</summary>
          <p className="mt-3 text-sm">{chapter.summary}</p>
          <ol className="mt-3 list-decimal space-y-3 pl-5 text-sm text-muted">
            {chapter.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </details>
      ))}
      {!chapters.length && <p role="status">No hay resultados para esa búsqueda.</p>}
    </div>
  );
}
