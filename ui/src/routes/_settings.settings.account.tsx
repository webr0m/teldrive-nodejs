import { createFileRoute } from "@tanstack/react-router";
import { AccountSettings } from "./_settings.settings.index";
export const Route = createFileRoute("/_settings/settings/account")({ component: AccountSettings });
