# Namecheap y un nodo de medios adicional

El nodo secundario acelera las lecturas privadas, reproducción, selección de pistas y conversión de medios. El servidor principal sigue atendiendo acceso, Google OAuth, subidas y enlaces públicos. Un portal opcional del PC permite iniciar sesión con la cuenta administrativa existente, gestionar sus límites y su TOML, y acceder a la administración global a través del principal. Esto distribuye trabajo de medios; no es una réplica completa ni sustituye al principal si deja de funcionar toda la aplicación.

## Seguridad y sesiones

- El secundario escucha exclusivamente en loopback y se publica mediante un túnel saliente de Cloudflare. No se abren puertos del router.
- Cada petición al secundario exige `MEDIA_NODE_SECRET`, además de la sesión o ticket normal de Teldrive. La clave interna no es una credencial de usuario ni salta la comprobación de permisos.
- Un `TELEGRAM_INSTANCE_ID` estable y distinto permite autenticar claves propias de bots. El secundario tiene prohibido abrir la sesión personal del usuario. Una cuenta sin bots utilizables sigue descargando por el principal.
- No hay cambios de esquema, migración de archivos ni copia local de los objetos Telegram. Se usa la misma base de metadatos y las mismas claves de cifrado existentes.
- Trabajos, limpieza de subidas, rclone, OAuth y las escrituras del catálogo permanecen en el principal. Los contadores de enlaces públicos también permanecen allí. Solo el propietario puede guardar la configuración local del nodo.

## Configurar el PC

El equipo debe tener una instalación funcional del servidor y su configuración privada de conexión. Crear `.env.media-node` (excluido de Git) con una clave aleatoria de 32 bytes en base64url:

```dotenv
MEDIA_NODE_SECRET=GENERAR_UN_SECRETO_ALEATORIO
MEDIA_NODE_INSTANCE_ID=pc-nombre-unico-y-estable
MEDIA_NODE_PORT=3010
MEDIA_NODE_TRANSFERS=4
MEDIA_NODE_CONCURRENCY=2
MEDIA_NODE_THREADS=2
MEDIA_NODE_BOT_POOL=4
OWNER_USER_ID=ID_TELEGRAM_DEL_PROPIETARIO
MEDIA_NODE_ADMIN=true
MEDIA_NODE_PUBLIC_ORIGIN=https://cloud-pc.example.com
MEDIA_NODE_PRIMARY_ORIGIN=https://cloud.example.com
```

Ejecutar `node scripts/media-node.mjs`. Este perfil utiliza los datos privados de `.env`/`config.toml`, guarda su estado local en `var/media-node` y no modifica la configuración del principal. Opcionalmente configurar `MEDIA_NODE_DATA_DIR`, `MEDIA_NODE_RATE_LIMIT`, `MEDIA_NODE_FFMPEG` y `MEDIA_NODE_FFPROBE`. Los ejecutables FFmpeg de las dependencias oficiales se usan por defecto.

El supervisor de Windows `scripts/run-media-node.ps1 -NodeExecutable RUTA_ABSOLUTA_A_NODE` reinicia el proceso tras una salida. Crear `var/media-node/stop` evita que vuelva a iniciarlo; hay que detener además el proceso activo para pararlo inmediatamente. El inicio automático necesita registrar el supervisor al iniciar sesión. El equipo debe permanecer encendido y conectado; suspenderlo o apagarlo deja de aportar capacidad.

El portal conserva el control por ID de propietario: no convierte otras cuentas en administradores. **Límites del servidor** en el portal del PC guarda un registro propio de ese nodo, sin reemplazar los límites de Namecheap. **Configuración del servidor** edita `var/media-node/config.admin.toml`; los secretos se ocultan y las claves de cifrado, rol, puertos e identidad del nodo están protegidos. El botón de reinicio utiliza un marcador local que detecta el supervisor. **Usuarios y permisos** siguen siendo globales y los valida el servidor principal; acceder al portal no otorga permisos adicionales.

Los inicios de sesión desde el portal se tramitan en el principal y crean sesiones normales de Teldrive. El nodo comparte esos permisos web, pero no conecta la clave personal MTProto desde otra máquina. Los bots del secundario usan sus propias claves. Si el principal no está disponible, no se podrán realizar nuevos inicios de sesión ni la administración global.

Si una cuenta no dispone de bots utilizables, el portal también solicita sus medios al principal al recibir un 503 del nodo. El respaldo conserva los rangos y los permisos del usuario, sin repetir escrituras ni rechazos 401/403/404. La configuración local del PC permanece en el propio nodo.

Publicar únicamente `127.0.0.1:3010` mediante una ruta del túnel, por ejemplo `cloud-pc-origin.example.com`. Ese origen interno debe permanecer sin rutas de Workers y rechazar cualquier petición sin la clave. Para el portal, un **Custom Domain** del Worker en `cloud-pc.example.com` reenvía al origen interno y añade la clave; no se entrega al navegador. Se necesitan nombres separados porque una ruta de Worker no admite ser el destino de un `fetch()` desde la misma zona. El formulario no necesita desactivar TLS de Cloudflare ni exponer discos/carpetas locales. Para usar solamente medios, desactivar `MEDIA_NODE_ADMIN` en ambos y limitar la ruta del túnel a los endpoints de medios/salud.

## Balanceador de Cloudflare

`edge/media-balancer.mjs` es un Worker sin dependencias externas. Las rutas y variables de ejemplo están en `edge/wrangler.jsonc`. Por defecto está desactivado. Antes de publicar, ajustar el dominio y el origen secundario y guardar `MEDIA_NODE_SECRET` como un **Secret** de Worker. No ponerlo en el código, variables públicas, Git o el TOML de ejemplo.

| Variable | Uso |
| --- | --- |
| `PUBLIC_ORIGIN` | Origen público exacto que ya sirve el principal |
| `MEDIA_NODE_ENABLED` | `true` activa la selección; `false` envía todo al principal |
| `MEDIA_NODE_ORIGIN` | Origen HTTPS del túnel secundario |
| `MEDIA_NODE_PORTAL_ORIGIN` | Custom Domain HTTPS del portal; diferente del origen del túnel |
| `MEDIA_NODE_ADMIN` | `true` habilita la ruta del portal del PC; sigue requiriendo el acceso normal de Teldrive |
| `MEDIA_NODE_WEIGHT` | Peso de capacidad, 0.05–10; 1 por defecto |
| `HEALTH_TTL_MS` | Vigencia de las mediciones por instancia del Worker, 1–60 s |
| `HEALTH_TIMEOUT_MS` | Tiempo máximo de consulta de salud, 0.1–10 s |
| `MEDIA_HEADER_TIMEOUT_MS` | Espera máxima de cabeceras del secundario, 1–60 s; no limita el stream activo |

Se compara salud, latencia y ocupación. Las mediciones se guardan temporalmente por instancia del Worker y no constituyen una visión global de toda la red. Las respuestas privadas se transmiten sin almacenarlas en caché. `Range`, autorización y cabeceras de seguridad se conservan. La clave interna se añade exclusivamente al origen secundario.

Solo las lecturas de contenido privado y playback pueden cambiar de origen. Nunca se repiten escrituras. Una respuesta 401/403/404 no cambia de servidor. Un error de red, 429 o 5xx permite probar el otro origen antes de devolver cabeceras o bytes al cliente. Una transferencia ya iniciada no puede moverse: si se corta, el cliente debe reanudar mediante otra petición Range. La respuesta balanceada incluye `X-Teldrive-Origin: primary|secondary` para verificar el recorrido.

Los Workers gratuitos tienen cuotas. Configurar las rutas en modo de fallo abierto al alcanzar los límites deja pasar el tráfico al principal, sin contratar el producto Load Balancing de pago. No se garantiza capacidad ilimitada. Las rutas de ejemplo solo interceptan las familias `playback*` y `files/*`; las escrituras que coincidan siguen pasando una sola vez al principal.

## Validación y reversión

1. Probar la salud autenticada del nodo y verificar rechazo sin secreto.
2. Probar un archivo autorizado con checksum y Range en ambos orígenes; verificar rechazo con sesión revocada y ticket inválido.
3. Comprobar bots independientes y ausencia de conexiones personales desde el nodo.
4. Comprobar pistas y una conversión utilizando la entrada local protegida del secundario.
5. Apagar el secundario y comprobar que las nuevas peticiones vuelven al principal.
6. Desactivar `MEDIA_NODE_ENABLED` o retirar las rutas del Worker para volver al despliegue anterior. No hace falta restaurar la base de datos.

Referencias: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/), [cuotas de Workers](https://developers.cloudflare.com/workers/platform/limits/), [rutas de Workers](https://developers.cloudflare.com/workers/configuration/routing/routes/).
