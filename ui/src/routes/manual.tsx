import { createFileRoute, Link } from "@tanstack/react-router";
import { ClientHelp } from "@/components/client-help";
export const Route = createFileRoute("/manual")({ component: Manual });
function Manual() {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-10 text-foreground">
      <Link to="/login" search={{ redirect: "/files" }} className="text-accent">
        ← Volver al inicio de sesión
      </Link>
      <ClientHelp tour={false} />
    </main>
  );
}
