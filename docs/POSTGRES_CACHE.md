# Caché temporal en PostgreSQL

El servidor admite dos capas para los resultados de FFprobe (pistas, códecs,
duración y compatibilidad H.264): memoria local y, opcionalmente, PostgreSQL.
La segunda capa permite reutilizar análisis después de reiniciar Passenger y
entre procesos que tengan acceso a esa misma base. Supabase sigue siendo la
fuente principal de archivos, permisos, cuentas, canales y bots.

No se almacenan vídeos, bloques de Telegram, tokens, contraseñas, sesiones ni
decisiones de autorización. Cada solicitud vuelve a validar su ticket antes de
consultar la caché. Cambiar de propietario, base principal, generación, partes,
tamaño o parámetros de análisis produce una clave nueva. Las entradas antiguas
caducan y se eliminan automáticamente. No es una migración de la base principal.

## Configuración del propietario

Crear una base y un usuario exclusivos desde cPanel, con acceso local. En
Configuración del servidor, añadir al TOML privado:

```toml
[node.cache]
backend = "postgres"
postgres-url = "postgresql://USUARIO@127.0.0.1/BASE_CACHE"
postgres-password = 'CLAVE'
schema = "teldrive_cache"
ttl-seconds = 86400
max-entries = 1000
memory-entries = 200
max-value-bytes = 65536
pool-size = 2
timeout-ms = 250
retry-seconds = 30
cleanup-seconds = 60
```

Guardar y reiniciar la aplicación. El editor oculta la URL mediante
`__TELDRIVE_KEEP_SECRET__`, al igual que la contraseña separada. Esta última evita
codificar manualmente caracteres especiales de una contraseña dentro de una URL.
También existen variables `CACHE_*` equivalentes en
`.env.example`. Para volver a memoria basta con `backend = "memory"` y reiniciar.
No cambiar `DATABASE_URL` ni `DATABASE_TRANSPORT` para activar esta opción.

El usuario necesita crear el esquema, su tabla y el índice dentro de la base de
caché. El servidor crea una tabla `UNLOGGED` con caducidad e índice. Una caída de
PostgreSQL puede vaciarla: ese contenido se regenera. Los valores están cifrados
con AES-256-GCM y una clave derivada de `DATA_KEY`; el identificador y la fecha de
caducidad están ligados al contenido cifrado. El esquema y tabla revocan acceso
de `PUBLIC`. Una base remota exige `sslmode=verify-full` y certificados válidos.

La tabla tiene un límite de entradas y cada valor tiene un tamaño máximo. Los
valores por defecto limitan los datos cifrados vivos aproximadamente a 64 MiB,
más índices, espacio libre y sobrecarga de PostgreSQL; no equivalen a una cuota
física exacta en disco. La memoria local conserva como máximo 200 valores de
64 KiB por proceso. La limpieza borra expirados cada 60 segundos y cada escritura
recorta el exceso mediante un bloqueo entre escritores.

Las lecturas son asíncronas. Se limita el número de operaciones en curso y se
descartan operaciones opcionales si están ocupadas las conexiones, sin formar
una cola ilimitada. Las escrituras ocurren en segundo plano. Si la base falla,
se usa memoria y se suspende el intento durante 30 segundos. El arranque y la
reproducción no dependen de que esa base esté disponible. El GET privado
`/api/v1/admin/configuration` incluye `cache` con estado y contadores sin secretos.

## Alcance

Esta caché evita repetir análisis de pistas. No aumenta directamente el ancho de
banda de Telegram ni reemplaza el lector concurrente de archivos. PostgreSQL usa
memoria y disco: no es una ampliación de la RAM de Node ni un sustituto idéntico
de Redis. El nodo del PC puede conservar su caché en memoria; no hay que exponer
el puerto de PostgreSQL del hosting a Internet para que siga funcionando.

Referencias: [tablas UNLOGGED de PostgreSQL](https://www.postgresql.org/docs/current/sql-createtable.html)
y [pool asíncrono de node-postgres](https://node-postgres.com/apis/pool).
