# Teldrive Node.js

Port inicial del núcleo web de [webr0m/teldrive](https://github.com/webr0m/teldrive). Reutiliza la interfaz React de la rama `teldrive-v2-drive-es`, commit `e970c75502711abccdfe57c7fe2ae8961c5ed1d1`, con sus estilos, traducciones y visores. Añade **Configuración → Límites del servidor** dentro de esa misma interfaz, un servidor Node.js con MTProto y un modo opcional de pasarela.

**Versión inicial: no es un port completo ni un reemplazo validado de todos los clientes de Teldrive.** Consulta [el estado de la migración](docs/MIGRATION.md) antes de usar una base existente. Las transferencias reales con Telegram y el hosting de destino necesitan validación con las credenciales del propietario.

## Uso local

Node.js 24. Instala y compila la interfaz antes de iniciar:

```sh
pnpm install --frozen-lockfile
pnpm --dir ui install --ignore-workspace --frozen-lockfile
pnpm --dir ui run build
pnpm run demo
```

La demo escucha solamente en `http://127.0.0.1:3000`, utiliza disco local y no necesita Telegram. El acceso de demostración está bloqueado en producción.

## Telegram y configuración

Copia `.env.example` a `.env` y configura `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `ALLOWED_USERS`, `DATA_KEY` y `PUBLIC_URL`. Genera `DATA_KEY` con:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npm start
```

Usa tus credenciales de aplicación de [my.telegram.org](https://my.telegram.org). Guarda una copia de `DATA_KEY`: cifra las sesiones y, en instalaciones nuevas, el contenido. El primer usuario permitido de una instalación nueva es propietario. La adaptación v2 conserva el rol de la base; para v1 configura `OWNER_USER_ID`.

## Usar el mismo TOML y PostgreSQL

Se lee automáticamente `config.toml`, o la ruta indicada por `CONFIG_FILE`. Se admiten los nombres v1 `[server]`, `[db]`, `[jwt]`, `[tg]` y los v2 `[http]`, `[database]`, `[telegram]`, `[security]` y `[encryption]` para sus equivalentes implementados. Añade `[node]` y `[node.limits]` como en [config.sample.toml](config.sample.toml). Las variables de entorno tienen prioridad. Aceptar un TOML no implica implementar todos sus módulos: consulta [el estado de compatibilidad](docs/MIGRATION.md).

`[db] data-source` selecciona el esquema v1 `legacy`; `[database] url` selecciona `auto`, que reconoce v1/v2. Se reutilizan **las mismas tablas** de archivos, usuarios, canales y, en v2, `file_parts`, preservando mensajes, sales y versiones de claves. Node crea `teldrive_node.records` para su estado adicional. No ejecuta migraciones Go. En producción, una base existente sin `allowed-users` admite solamente usuarios ya registrados.

Valida sobre una copia antes de sustituir el servicio. `node scripts/snapshot-db.mjs config.toml` crea una instantánea cifrada de las tablas en `var/backups`; complementa un respaldo PostgreSQL del proveedor, no sustituye `pg_dump`. Las copias en bases existentes usan mensajes nuevos de Telegram. Los enlaces y sesiones web emitidos por Go permanecen intactos; Node requiere iniciar sesión y crear sus propios enlaces. Las cargas pendientes de Go, ACL, favoritos y estados de visor anteriores todavía no se importan.

Si el hosting no permite PostgreSQL saliente, [la conexión Supabase por HTTPS y RPC](docs/SUPABASE.md) usa el puerto 443 sobre el mismo catálogo v2, sin cambiar el TOML del otro Teldrive.

## Límites y migración de servidor

En **Configuración → Límites del servidor** puedes cambiar tamaño de parte, máximo por archivo, concurrencia, caducidad de cargas, límites por IP y tamaño de JSON. Los cambios se guardan en la misma base y tienen prioridad sobre los valores iniciales del entorno/TOML. Las cargas existentes conservan su tamaño de parte y máximo. La configuración no elimina los límites que impongan Telegram, Cloudflare o el hosting.

En una migración conserva la base, `DATA_KEY`, el antiguo `encryption-key` y los archivos de `DATA_DIR` que uses con almacenamiento local. Los secretos y las rutas de infraestructura se configuran en el servidor.

## Integración en otras páginas

La aplicación funciona directamente en el navegador. Para integrar su API autoriza orígenes exactos con `CORS_ORIGINS` y crea una clave desde Administración. Una clave de usuario da acceso a toda su unidad: úsala en el servidor de tu otra aplicación; no la publiques en JavaScript enviado a visitantes.

```js
const response = await fetch('https://cloud.webrom.lat/api/v1/files?scope=drive', {
  headers: { 'X-Api-Key': process.env.TELDRIVE_API_KEY }
});
```

Para incrustar la interfaz habilita `ALLOW_IFRAME=true` y añade:

```html
<script src="https://cloud.webrom.lat/embed.js" data-height="800" defer></script>
```

La autenticación dentro de un iframe depende de las políticas de cookies del navegador. Si el navegador restringe las cookies de terceros, abre el dominio directamente.

## Conservar el motor original

`MODE=gateway` y `UPSTREAM_URL=https://tu-servidor-teldrive.example` publican la interfaz y API originales a través de Node, incluidos streaming y WebSockets. Este modo sigue necesitando el motor Go; no es un port nativo. El origen es fijo y no se puede elegir desde una petición del visitante.

## Comprobaciones

```sh
npm run check
npm test
pnpm --dir ui run typecheck
pnpm --dir ui run build
```

Pruebas de ciclo completo con almacenamiento local, aislamiento entre usuarios, descargas parciales entre partes cifradas, reintentos, enlaces con contraseña, límites y persistencia. Las pruebas PostgreSQL usan el motor embebido PGlite con una estructura representativa del fork; no reemplazan una prueba con una copia de la base real.

Despliegue: [Namecheap y Cloudflare](docs/DEPLOYMENT.md). Licencia MIT; se conserva la atribución del proyecto original.
