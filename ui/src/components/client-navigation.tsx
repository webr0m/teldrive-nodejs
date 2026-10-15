import { Button, Input, Modal } from "@heroui/react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import BackIcon from "~icons/gravity-ui/arrow-left";
import MenuIcon from "~icons/gravity-ui/bars";
import FolderIcon from "~icons/gravity-ui/folder";
import ShareIcon from "~icons/gravity-ui/link";
import SettingsIcon from "~icons/gravity-ui/gear";
import SearchIcon from "~icons/gravity-ui/magnifier";
import { clientSecondaryNavigation, clientSettings } from "@/lib/client-navigation";
import { t } from "@/lib/localization";

export function ClientNavigation({ children }: { children: React.ReactNode }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const search = useLocation({ select: (location) => location.search as Record<string, unknown> });
  const [query, setQuery] = useState(typeof search.q === "string" ? search.q : "");
  useEffect(() => setQuery(typeof search.q === "string" ? search.q : ""), [search.q]);
  useEffect(() => setMenuOpen(false), [pathname]);
  const settingsPage = clientSettings
    .flatMap((group) => [...group.items])
    .find((item) => item.path === pathname);
  const title =
    settingsPage?.label ??
    (pathname.startsWith("/settings")
      ? "Configuración"
      : pathname === "/search"
        ? "Buscar"
        : pathname === "/shared"
          ? "Compartidos"
          : (clientSecondaryNavigation.find((item) => item.path === pathname)?.label ??
            "Archivos"));
  const settingsChild = pathname.startsWith("/settings/");
  const tabs = [
    {
      path: "/files",
      label: "Archivos",
      icon: FolderIcon,
      active: pathname === "/files" || pathname === "/search",
    },
    { path: "/shared", label: "Compartidos", icon: ShareIcon, active: pathname === "/shared" },
    {
      path: "/settings",
      label: "Ajustes",
      icon: SettingsIcon,
      active: pathname.startsWith("/settings"),
    },
  ];
  return (
    <>
      <header className="client-app-header flex shrink-0 items-center gap-2 border-b border-border px-3">
        {settingsChild || pathname === "/search" ? (
          <Button
            isIconOnly
            variant="ghost"
            aria-label={t("Volver")}
            onPress={() => void navigate({ to: settingsChild ? "/settings" : "/files" })}
          >
            <BackIcon className="size-5" />
          </Button>
        ) : (
          <img src="/images/teldrive.png" alt="" className="size-7 shrink-0" />
        )}
        {pathname === "/search" ? (
          <form
            className="min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              void navigate({ to: "/search", search: { ...search, q: query.trim() || undefined } });
            }}
          >
            <Input
              aria-label={t("Buscar archivos")}
              placeholder={t("Buscar archivos")}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              enterKeyHint="search"
              maxLength={512}
              autoFocus
            />
          </form>
        ) : (
          <p className="min-w-0 flex-1 truncate text-base font-semibold">{t(title)}</p>
        )}
        {pathname === "/files" && (
          <Button
            isIconOnly
            variant="ghost"
            aria-label={t("Buscar archivos")}
            onPress={() => void navigate({ to: "/search" })}
          >
            <SearchIcon className="size-5" />
          </Button>
        )}
      </header>
      {children}
      <nav
        aria-label={t("Navegación de la aplicación")}
        className="client-bottom-nav grid shrink-0 grid-cols-4 border-t border-border bg-background"
      >
        {tabs.map((tab) => (
          <Link
            key={tab.path}
            to={tab.path}
            aria-current={tab.active ? "page" : undefined}
            className={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 px-1 text-[0.6875rem] ${tab.active ? "text-accent" : "text-muted"}`}
          >
            <tab.icon className="size-5" />
            <span>{t(tab.label)}</span>
          </Link>
        ))}
        <Button
          variant="ghost"
          aria-label={t("Más opciones de la aplicación")}
          aria-expanded={menuOpen}
          onPress={() => setMenuOpen(true)}
          className={`h-auto min-h-14 min-w-0 flex-col gap-1 rounded-none px-1 text-[0.6875rem] ${clientSecondaryNavigation.some((item) => item.path === pathname) ? "text-accent" : "text-muted"}`}
        >
          <MenuIcon className="size-5" />
          <span>{t("Más")}</span>
        </Button>
      </nav>
      <Modal.Backdrop isOpen={menuOpen} onOpenChange={setMenuOpen} isDismissable>
        <Modal.Container size="sm" scroll="inside" className="client-menu-container">
          <Modal.Dialog className="min-w-0">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{t("Más opciones")}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <nav aria-label={t("Más secciones")} className="flex flex-col gap-1">
                {clientSecondaryNavigation.map((item) => (
                  <Link
                    key={item.path}
                    to={item.path}
                    onClick={() => setMenuOpen(false)}
                    className="flex min-h-12 items-center rounded-xl px-3 text-sm hover:bg-default/30"
                  >
                    {t(item.label)}
                  </Link>
                ))}
              </nav>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}

export function ClientSettingsHome() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 pb-3">
      <h1 className="sr-only">{t("Configuración")}</h1>
      {clientSettings.map((group) => (
        <section key={group.title} className="space-y-2">
          <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">
            {t(group.title)}
          </h2>
          <nav
            aria-label={t(group.title)}
            className="overflow-hidden rounded-2xl border border-border bg-surface"
          >
            {group.items.map((item) => (
              <Link
                key={item.path}
                to={item.path}
                aria-label={t(item.label)}
                className="flex min-h-16 min-w-0 items-center gap-3 border-b border-border px-4 py-3 last:border-0 hover:bg-default/20"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{t(item.label)}</span>
                  <span className="mt-1 block text-xs text-muted">{t(item.description)}</span>
                </span>
                <span aria-hidden="true" className="shrink-0 text-muted">
                  ›
                </span>
              </Link>
            ))}
          </nav>
        </section>
      ))}
    </div>
  );
}
