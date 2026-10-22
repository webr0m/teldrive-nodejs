# Concurrencia y pausas de reproducción — 22 de octubre de 2026

## Hallazgos

- El port anterior utilizaba un solo `iterDownload` secuencial por rango HTTP. `DOWNLOAD_BOTS=200` no creaba 200 lectores: limitaba los candidatos para rotación y respaldo. El original Go v2 sí implementa lecturas paralelas y un búfer acotado (`internal/telegramstore/gotd.go`, `download-read-parallel` y `download-read-buffers`). Un bot puede servir varias solicitudes de bloques simultáneamente; distintos flujos pueden usar distintos bots. No es necesario que todos los bots colaboren en cada archivo.
- La preferencia por un bot caliente podía hacer esperar a otra solicitud detrás de ese bot, aunque hubiera bots fríos desocupados. La selección ahora considera las reservas antes de preferir conexiones calientes.
- El puente síncrono de Supabase detenía el bucle de Node mientras esperaba cada respuesta HTTPS. Era especialmente perjudicial en la consulta repetida de estadísticas. Autenticación por sesión, resolución de permisos de reproducción y lecturas del panel ahora se hidratan mediante RPC asíncronas correlacionadas. La caché existe solo dentro de una solicitud; una solicitud nueva vuelve a consultar los permisos y revocaciones. Las escrituras y las API que no se han adaptado conservan el puente síncrono.
- Una comprobación local con la base real tardó aproximadamente 570 ms en tres consultas repetidas de bots. Con la caché de solicitud se realizó una consulta, en aproximadamente 163 ms, y el temporizador del proceso siguió avanzando durante la espera. Es una muestra del acceso a metadatos, no un benchmark de transferencia ni una garantía de latencia.
- El vídeo MP4/WebM puede comenzar a cargar mientras se examinan las pistas. Los contenedores que requieren conversión siguen esperando la detección de la pista predeterminada.

## Hosting observado

En cPanel, el historial disponible del 22 de octubre, de 01:00 a 04:00 (America/Santiago), mostró CPU media de 14–16 % frente a un límite de 200 %, memoria media de 62–193 MiB frente a 2 GiB, 2–3 procesos de entrada frente a 30 y cero fallos de CPU, memoria, E/S o procesos en esos intervalos. La pantalla indicó que el consumo instantáneo detallado no estaba disponible. No se debe interpretar esa muestra como ausencia de saturaciones en cualquier otro momento. Los límites generales de la cuenta también afectan a sus demás sitios.

No se encontraron `redis-server`, `redis-cli` ni `memcached` en PATH, ni un servicio accesible en `127.0.0.1:6379` ni el socket Redis predeterminado. No se instaló un daemon adicional. La extensión PHP Redis que documenta Namecheap es un cliente y no demuestra que exista un servidor Redis para esta cuenta.

## Controles configurables

| Variable | Predeterminado | Función |
| --- | --- | --- |
| `DOWNLOAD_READ_PARALLEL` | 4 | Solicitudes de bloques simultáneas por flujo |
| `DOWNLOAD_READ_BUFFERS` | 8 | Máximo de bloques de 512 KiB adelantados, incluidos los que están en vuelo |
| `DOWNLOAD_MAX_PARALLEL` | 16 | Máximo de lecturas de bloques simultáneas por proceso Node |
| `DOWNLOAD_READ_TIMEOUT_SECONDS` | 15 | Espera máxima por bloque; permite intentar otro bot |

Los límites se editan en **Límites del servidor** por el propietario. También se admiten en `[node.limits]`, usando nombres en minúsculas con guiones. Se reconocen los nombres originales `[telegram] download-read-parallel` y `download-read-buffers`; las variables de entorno y los límites guardados conservan su precedencia. El paralelismo efectivo nunca supera el número de bloques de búfer ni el límite global. Cada nodo mantiene su propio perfil.

`MAX_CONCURRENT_TRANSFERS` limita flujos HTTP/subidas, no solicitudes MTProto. `BOT_CLIENT_POOL_SIZE` limita conexiones inactivas conservadas; no debe confundirse con la cantidad de lecturas simultáneas. `MEDIA_CONCURRENCY` limita procesos FFmpeg/ffprobe. Elevar todas las cifras al máximo puede empeorar las esperas y el consumo.

El lector conserva el orden de los bytes, limita la memoria adelantada, respeta la contrapresión del cliente y cancela el trabajo pendiente al cerrar el visor. Si falla un bot, reanuda desde el último byte emitido, sin duplicados. El panel muestra lecturas RPC activas y pico observado, separados del número de flujos HTTP y del límite configurado.

## Alcance y límites

Supabase continúa siendo la base principal. No hay una caché global de autorizaciones ni se cambian las tablas compartidas con Go. La caché temporal de solicitud es local a cada proceso, no sustituye un Redis distribuido y desaparece al terminar la solicitud. Redis externo podría servir para metadatos derivados o coordinación, pero necesitaría un endpoint autenticado y una política de invalidación; no eliminaría por sí solo las esperas síncronas del código.

Fuentes: [transferencias Telegram](https://core.telegram.org/api/files), [límites LVE de Namecheap](https://www.namecheap.com/support/knowledgebase/article.aspx/1127/103/a-handy-guide-to-resource-limits-or-what-is-lve/), [módulos PHP y extensión cliente Redis](https://www.namecheap.com/support/knowledgebase/article.aspx/9697/2219/php-modules-limits-and-extensions-on-shared-hosting-servers/).
