import { nativeClient } from "./client-runtime";

export const clientSettings = [
  {
    title: "Tu cuenta",
    items: [
      {
        path: "/settings/account",
        label: "Cuenta y acceso con Google",
        description: "Telegram, Google y cerrar sesión",
      },
      {
        path: "/settings/channels",
        label: "Canales de Telegram",
        description: "Elige dónde guardar las nuevas subidas",
      },
      { path: "/settings/bots", label: "Bots", description: "Administra los bots de tu unidad" },
      {
        path: "/settings/sessions",
        label: "Sesiones",
        description: "Revisa y revoca los accesos a tu cuenta",
      },
    ],
  },
  {
    title: "Preferencias",
    items: [
      {
        path: "/settings/uploads",
        label: "Subidas",
        description: "Cifrado, nombres y transferencias",
      },
      {
        path: "/settings/appearance",
        label: "Apariencia",
        description: "Tema, idioma y densidad de la interfaz",
      },
      ...(nativeClient
        ? [
            {
              path: "/settings/privacy",
              label: "Privacidad y publicidad",
              description: "Consentimiento y caché del dispositivo",
            },
          ]
        : []),
    ],
  },
  {
    title: "Ayuda",
    items: [
      {
        path: "/settings/help",
        label: "Ayuda y manual",
        description: "Instrucciones y recorrido de la aplicación",
      },
      {
        path: "/settings/info",
        label: "Acerca de Teldrive",
        description: "Versión y datos del cliente",
      },
    ],
  },
] as const;
export const clientSecondaryNavigation = [
  { path: "/shared-with-me", label: "Compartido conmigo" },
  { path: "/trash", label: "Papelera" },
  { path: "/spam", label: "Spam" },
  { path: "/storage", label: "Almacenamiento" },
] as const;
