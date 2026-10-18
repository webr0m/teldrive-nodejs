# Estadísticas del reproductor

En vídeo y audio, **Estadísticas · Desarrollador** abre un panel opcional. Muestra información disponible del contenedor y las pistas; resolución decodificada, posición, búfer, estado de red, fotogramas y esperas observadas; solicitudes Range, primer byte, orígenes y bots por nombre, alias e ID; lectura recibida y bytes enviados; y progreso de FFmpeg cuando se usa conversión.

Los datos del navegador se muestrean cada segundo mientras el panel está abierto. Las consultas del servidor se realizan cada dos segundos después de completar la anterior; se suspenden con la página oculta y al cerrar el panel. Las velocidades son medias de los últimos tres segundos, no el bitrate declarado del archivo. Los campos que el navegador o ffprobe no proporcionan se muestran como no disponibles.

Cada permiso de reproducción tiene contadores separados. `AsyncLocalStorage` vincula los intentos efectivos de transferencia y sus bytes a la solicitud correspondiente. Una caída de bot conserva los bytes recibidos y muestra el siguiente origen real, incluida la cuenta de Telegram de respaldo. Las lecturas de análisis y de entrada de FFmpeg se distinguen de los bytes enviados al reproductor. El cifrado, la alineación de bloques, el análisis y los reintentos pueden producir cantidades distintas.

El balanceador consulta las estadísticas del principal y del PC; no elige un solo nodo para esa consulta. Primero valida la sesión y el permiso en el principal. Si el PC no responde, se indica que sus datos no están disponibles. Un nodo que no recibió tráfico muestra cero solicitudes, no bots inventados. Un navegador puede seguir reproduciendo desde el búfer sin consumir datos de Telegram.

La API `GET /api/v1/playback/diagnostics?ticket=…` exige una sesión del propietario del archivo, valida el permiso de reproducción y su revocación, y excluye permisos de enlaces públicos. No devuelve tokens, claves MTProto, URLs de reproducción ni direcciones internas. Los metadatos de ffprobe usan una lista de campos permitidos: nunca se devuelve su `filename`, que contiene el permiso temporal. Copiar diagnóstico copia solo estos datos y las mediciones del navegador.

La colección usa memoria y no escribe en PostgreSQL/Supabase por cada bloque. Se retienen hasta 64 solicitudes recientes y 256 orígenes por sesión; los totales acumulados se conservan mientras exista la sesión en memoria. Un reinicio o una expulsión de caché reinicia las cifras. Los límites por nodo se pueden ajustar en **Límites del servidor**, por el propietario:

| Variable | Predeterminado | Uso |
| --- | --- | --- |
| `PLAYBACK_DIAGNOSTICS_ENABLED` | `1` | `0` desactiva la colección |
| `PLAYBACK_DIAGNOSTICS_MAX_SESSIONS` | `128` | Capacidad de sesiones en memoria |
| `PLAYBACK_DIAGNOSTICS_TTL_SECONDS` | `600` | Caducidad de sesiones inactivas |

Se admiten también en `[node.limits]` del TOML con nombres en minúsculas y guiones. El PC conserva su perfil de límites independiente. No se requieren tablas ni migraciones de base de datos. En pantalla completa mediante Fullscreen API el panel se integra en el elemento activo; el reproductor nativo a pantalla completa de iOS no admite superponer HTML.
