import { createFileRoute } from "@tanstack/react-router";
import { useCurrentUser } from "@/auth/use-current-user";
import { EmptyState, Page } from "@/components/page";
import { t } from "@/lib/localization";
import {
  SharedFileBrowser,
  SharedPageSpinner,
  sharedBrowserSearch,
} from "@/features/files/shared-file-browser";

export const Route = createFileRoute("/shared-with-me")({
  validateSearch: sharedBrowserSearch,
  component: SharedWithMePage,
  pendingComponent: SharedPageSpinner,
});

function SharedWithMePage() {
  const account = useCurrentUser();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  if (!(account.data.capabilities as readonly string[]).includes("files.manageGrants"))
    return (
      <Page>
        <EmptyState
          title={t("Compartido conmigo")}
          description={t(
            "Este servidor todavía no admite compartir archivos entre cuentas. Puedes acceder a los enlaces de lectura recibidos.",
          )}
        />
      </Page>
    );

  return (
    <SharedFileBrowser
      mode="with-me"
      search={search}
      navigate={(next, replace) => void navigate({ search: next, replace })}
    />
  );
}
