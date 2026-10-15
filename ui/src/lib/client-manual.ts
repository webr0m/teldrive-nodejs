export const clientManual = [
  {
    id: "cuenta",
    title: "Tu cuenta y el acceso",
    summary:
      "Telegram conserva la identidad de tu unidad. Google puede facilitar los siguientes accesos.",
    steps: [
      "La primera vez entra con tu número de Telegram y el código que recibas. Si tienes verificación en dos pasos, introduce también su contraseña.",
      "Desde Configuración → Cuenta puedes vincular Google después de un acceso reciente con Telegram. En los próximos accesos podrás elegir Google.",
      "Una cuenta de Google sin vincular no crea ni toma otra unidad. El servidor debe tener Google configurado para habilitar el botón.",
      "Cierra la sesión desde Cuenta. En Sesiones puedes revocar otros accesos. Desvincular Google cierra los accesos móviles iniciados con esa identidad.",
    ],
  },
  {
    id: "canales",
    title: "Elegir el canal de tu unidad",
    summary: "Selecciona el canal de Telegram donde se guardarán tus nuevas subidas.",
    steps: [
      "Abre Ajustes en la barra inferior y entra en Canales de Telegram. El canal marcado En uso es el destino de las nuevas subidas.",
      "Pulsa Buscar canales en Telegram para consultar los canales disponibles de tu cuenta. Pulsa Usar canal para guardar tu elección. Tu cuenta y los bots necesitan los permisos correspondientes en ese canal.",
      "Cambiar de canal no mueve ni elimina los archivos existentes: seguirán disponibles en la misma unidad. Las transferencias que ya comenzaron conservan su canal original.",
      "La selección es una preferencia de tu cuenta en el servidor, no un montaje en el teléfono. Si compartes la misma cuenta y servidor en otras instalaciones, ten en cuenta esta preferencia al iniciar nuevas subidas.",
    ],
  },
  {
    id: "archivos",
    title: "Archivos y carpetas",
    summary: "Explora, busca y organiza tu unidad desde el teléfono.",
    steps: [
      "La barra inferior reúne Archivos, Compartidos, Ajustes y Más. Más contiene Compartido conmigo, Papelera, Spam y Almacenamiento; cada opción aparece una sola vez.",
      "Toca una carpeta para entrar y utiliza la ruta para volver. Vista permite cambiar entre lista y cuadrícula. Ordenar reúne el criterio y el sentido de ordenación.",
      "Selecciona un elemento y abre su menú de acciones para renombrarlo, moverlo, copiarlo, compartirlo o enviarlo a la papelera.",
      "El buscador encuentra nombres dentro de la ubicación seleccionada. Puedes ajustar los filtros y el orden.",
      "La papelera permite restaurar elementos. El borrado definitivo no se puede deshacer; revisa siempre la selección.",
    ],
  },
  {
    id: "subidas",
    title: "Subir y descargar",
    summary: "Transfiere documentos, fotos y otros archivos usando el selector del sistema.",
    steps: [
      "Usa Subir para elegir archivos de tu dispositivo. La bandeja de transferencias muestra el avance y permite pausar o reintentar.",
      "En Configuración → Subidas ajusta el cifrado de archivos nuevos, los conflictos de nombres y la concurrencia dentro de los límites del servidor.",
      "Mantén la app abierta durante una subida. Android o iOS pueden suspenderla en segundo plano; esta edición no garantiza subidas después de cerrar o reiniciar la app.",
      "Descargar prepara una copia temporal y abre Compartir/Guardar del sistema. Elige dónde conservarla. La caché temporal de la app se puede limpiar desde Privacidad.",
    ],
  },
  {
    id: "reproduccion",
    title: "Reproducir y leer",
    summary: "Abre vídeos, audio, imágenes, PDF y libros compatibles.",
    steps: [
      "Toca un archivo compatible para abrir su visor. Puedes volver a la lista sin cerrar tu sesión.",
      "En vídeo, las pistas de audio, vídeo y subtítulos disponibles dependen del archivo. La conversión necesita el servicio multimedia del servidor y puede tardar al comenzar.",
      "Las descargas y la reproducción requieren conexión. Solo los archivos que guardes en el dispositivo estarán disponibles fuera de línea.",
      "La publicidad se oculta mientras está abierto un visor. No se insertan anuncios dentro de tus vídeos.",
    ],
  },
  {
    id: "compartir",
    title: "Compartir con otras personas",
    summary: "Gestiona enlaces y archivos recibidos manteniendo el control de acceso.",
    steps: [
      "Compartir permite recuperar y copiar de nuevo el mismo enlace activo. Configura contraseña o caducidad cuando estén disponibles.",
      "Compartidos muestra lo que has compartido. Compartido conmigo reúne los elementos recibidos de otras cuentas.",
      "Revocar un enlace impide nuevos accesos. Quien descargó una copia conserva esa copia.",
      "Spam permite apartar elementos y la papelera permite restaurar los propios. Revisa a quién otorgas permisos de edición.",
    ],
  },
  {
    id: "bots",
    title: "Administrar tus bots",
    summary: "La edición móvil conserva los bots de tu cuenta.",
    steps: [
      "Abre Configuración → Bots para consultar, añadir o quitar tus propios bots según los permisos de tu cuenta.",
      "Crea el bot en Telegram con BotFather y utiliza su token en Teldrive. El token es una credencial: no lo compartas ni lo incluyas en capturas.",
      "Los bots necesitan acceso a los canales utilizados por tu unidad. Un fallo de permisos o de acceso a Telegram no se resuelve aumentando la concurrencia.",
      "Cambiar un bot puede afectar a otras instalaciones que usan la misma base. La app móvil no permite modificar usuarios ni límites globales del servidor.",
    ],
  },
  {
    id: "privacidad",
    title: "Privacidad y anuncios",
    summary: "Controla el consentimiento y conoce qué datos necesita el cliente.",
    steps: [
      "Las credenciales móviles se guardan en el almacén seguro del dispositivo. Google se usa para identificarte; no se solicita acceso a Google Drive ni a tus contactos.",
      "Si la publicidad de AdMob está habilitada, la app consulta las opciones de consentimiento antes de solicitar anuncios. Puedes revisarlas desde Privacidad.",
      "La publicidad propia puede mostrar imágenes y enlaces HTTPS configurados por el editor. No se envían nombres de archivos ni rutas de tu unidad a esa configuración.",
      "Los anuncios no bloquean funciones. Puedes cerrar un banner propio; los enlaces publicitarios abren una ventana separada y se identifican como publicidad.",
    ],
  },
  {
    id: "ayuda",
    title: "Resolver problemas",
    summary: "Pasos útiles antes de volver a autenticarte.",
    steps: [
      "Comprueba la conexión y vuelve a abrir la carpeta. Si la sesión venció, inicia sesión de nuevo.",
      "Si un vídeo falla, prueba otra pista o descarga el archivo para abrirlo con un reproductor del dispositivo.",
      "Si faltan archivos, revisa la cuenta de Telegram y la ruta, además de Papelera y Spam. Google no combina unidades distintas.",
      "El manual está incluido en la app. Usa Repetir recorrido para revisar de nuevo la introducción y consulta el soporte configurado por el editor.",
    ],
  },
] as const;
