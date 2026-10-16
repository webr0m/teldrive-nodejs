# CDN y hosting

Los recursos públicos de la interfaz pueden servirse desde Cloudflare; las API,
sesiones, enlaces compartidos y archivos de usuarios deben llegar siempre a Node.
No uses Cache Everything sobre el dominio completo ni ignores las cookies o
cabeceras del origen para forzar el almacenamiento de contenido privado.

## Política del servidor

| Contenido | Cache-Control |
| --- | --- |
| `/assets/` con hash de compilación | `public, max-age=31536000, immutable` |
| Fuentes, imágenes, recursos PDF y muestras demo incorporadas | `public, max-age=3600, must-revalidate` |
| HTML, API, sesiones, descargas, reproducción y enlaces de usuarios | `no-store` |
| Errores o respuestas que establecen cookies | `no-store` |

Los ETag permiten revalidar recursos sin descargar los bytes de nuevo. La política
se calcula sobre el archivo real: una ruta inexistente que devuelve el HTML de la
aplicación no hereda la caché de una carpeta pública.

El propietario puede cambiar el TTL de recursos sin hash con el editor privado:

```toml
[node.limits]
static-cache-bytes = 16777216
static-asset-max-age = 3600
```

El primer valor limita la memoria de la caché de Node; el segundo es el TTL en
segundos (0 desactiva la caché pública sin hash, máximo 604800). Se aplican tras
reiniciar el proceso. Para invalidar una versión que ya está en Cloudflare, purga
solo sus URL; evita purgar todo el dominio durante un despliegue.

## Cloudflare

Limita las reglas al hostname de esta instalación. Usa una regla que excluya de
caché todas las rutas salvo `/assets/`, `/fonts/`, `/images/`, `/pdfjs/`, `/demo/`
y `/client-pages.css`. Para esos recursos públicos, respeta Cache-Control tanto
en el perímetro como en el navegador; si falta la cabecera, omite la caché.
Conserva los parámetros de consulta en la clave y no fuerces TTL sobre errores.

HTTP/2, HTTP/3 y Brotli reducen el coste de entregar la interfaz. Smart Tiered
Cache reduce las peticiones al origen cuando distintos centros de datos tienen
un fallo de caché; es una opción de zona y afecta a otros hosts de esa zona.
No actives Rocket Loader de forma indiscriminada para esta aplicación de módulos.

Referencias: [Origin Cache Control](https://developers.cloudflare.com/cache/concepts/cache-control/),
[Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/),
[Smart Tiered Cache](https://developers.cloudflare.com/smart-shield/configuration/smart-tiered-cache/).

## Namecheap

Revisa Resource Usage antes de aumentar concurrencia o procesos. La memoria,
CPU y los procesos de entrada se comparten con los otros sitios de la cuenta.
Mantén NODE_ENV=production y los límites de transferencias, ffmpeg y bots acotados.
Evita compilar la interfaz en el hosting: despliega el build de CI.

Un error 522 es un fallo de conexión entre Cloudflare y el origen; la caché no
resuelve su causa para peticiones privadas. Guarda fecha UTC, ruta y CF-Ray para
que Namecheap compruebe el firewall, conexiones y disponibilidad de Apache.
No desactives el proxy, ModSecurity, SSL ni las comprobaciones de autenticación
para ocultar estos errores.

Referencias: [Error 522](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-522/),
[recursos de Namecheap](https://www.namecheap.com/support/knowledgebase/article.aspx/1128/103/ways-of-resolving-resource-overusage-issues/).
