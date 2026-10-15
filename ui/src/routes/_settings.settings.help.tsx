import { createFileRoute } from "@tanstack/react-router";
import { ClientHelp } from "@/components/client-help";
export const Route = createFileRoute("/_settings/settings/help")({ component: ClientHelp });
