# Namecheap reseller + Cloudflare

Destino solicitado: `cloud.webrom.lat`. Node se ejecuta en Namecheap y Cloudflare gestiona el DNS/proxy.

1. En la cuenta cPanel de destino, confirma **Setup Node.js App** y selecciona Node.js 24 (mínimo 22.13). Comprueba que `node:sqlite` y `worker_threads` están disponibles. Con PostgreSQL existente también se necesita una conexión permitida a ese servidor.
2. Crea el subdominio `cloud.webrom.lat` con una raíz de documentos vacía. Guarda el proyecto fuera de `public_html`, por ejemplo `/home/USUARIO/teldrive-nodejs`. Los secretos, el TOML y `var/` deben quedar fuera de las carpetas públicas.
3. Sube y extrae el ZIP generado con `npm run package`, o clona el repositorio. La aplicación tiene startup file **app.js**. Usa la URL `https://cloud.webrom.lat`, modo Production y la raíz del proyecto. Ejecuta `npm install --omit=dev` desde el entorno Node activado que muestra cPanel.
4. Configura variables del entorno o reutiliza `config.toml` añadiendo `[node]`. Establece `NODE_ENV=production`, `PUBLIC_URL=https://cloud.webrom.lat`, `DATA_KEY`, tus credenciales de Telegram, `ALLOWED_USERS` y `OWNER_USER_ID`. Deja `DEMO_AUTH=false`. Configura `PORT` según el entorno de Passenger.
5. Para reutilizar el catálogo: `DATABASE_URL` al mismo servidor y `DATABASE_LAYOUT=auto`, `v2` o `legacy`. El usuario PostgreSQL debe poder usar las tablas originales y crear/escribir el esquema `teldrive_node`. Se admiten el esquema UUID v1 posterior a 2024 y el v2 de la rama personalizada. Valida primero sobre una copia. No actives la migración v1 de Go desde esta aplicación.
6. En Cloudflare agrega el registro de `cloud` hacia la IP de esa cuenta cPanel o el hostname asignado por Namecheap. Configura TLS **Full (strict)** con un certificado válido en el origen. Las reglas de caché deben excluir `/api/*`. Mantén las partes por debajo del límite de cuerpo y duración del plan de Cloudflare; los límites de la aplicación no cambian el límite del proveedor.
7. Reinicia la aplicación. Comprueba `/healthz` y `/api/health/ready`, autentícate y realiza una carga pequeña, descarga completa, descarga parcial y una carga reanudada. Verifica el panel de límites. Las pruebas reales de Telegram son necesarias antes de migrar tus archivos.

El hosting reseller impone límites LVE de CPU, memoria y procesos; configurarlos en la aplicación reduce presión pero no aumenta la cuota del plan. Algunas transferencias con Telegram pueden exceder el timeout del proxy de Cloudflare. Si ocurre, usa un hostname de transferencias sin proxy o un servidor con capacidad adecuada; requiere revisar la ruta y el TLS en origen.

Fuentes: [Node.js en Namecheap](https://www.namecheap.com/support/knowledgebase/article.aspx/10047/2182/how-to-work-with-nodejs-app/), [límites LVE](https://www.namecheap.com/support/knowledgebase/article.aspx/1127/103/a-handy-guide-to-resource-limits-or-what-is-lve/), [límites de conexión Cloudflare](https://developers.cloudflare.com/fundamentals/reference/connection-limits/).

El archivo de estado de publicación debe distinguir código subido de servicio desplegado y pruebas reales completadas.

Para habilitar detección de pistas y conversión de audio/vídeo, ejecuta `node scripts/install-media.mjs` después de instalar las dependencias. Este paso instala únicamente los binarios de los dos paquetes fijados, manteniendo desactivados los demás scripts de instalación. Se pueden usar rutas propias mediante `FFMPEG_PATH` y `FFPROBE_PATH`. Los recursos de conversión se ajustan en «Límites del servidor».
