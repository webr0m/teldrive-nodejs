# Estado del port

Referencia: [webr0m/teldrive, teldrive-v2-drive-es](https://github.com/webr0m/teldrive/tree/teldrive-v2-drive-es), commit e970c75502711abccdfe57c7fe2ae8961c5ed1d1. Se conservan su interfaz React, localización y contrato generado. También se ofrece una adaptación del esquema UUID v1 de main, commit c12a1da.

**El motor Node es una versión inicial; conservar toda la interfaz no equivale a haber portado todas las operaciones del motor Go.**

| Función | Estado nativo |
| --- | --- |
| Interfaz personalizada, temas, traducciones y visores | Compila; revisión visual contra tel.webrom.lat |
| Límites persistentes dentro de la configuración original | Implementado y probado |
| Acceso Telegram por teléfono, 2FA y QR | Implementado; QR validado en el servidor publicado |
| Sesiones, renovación, claves API, roles y administración | Implementado; ciclo local probado |
| Carpetas, búsqueda de texto, favoritos, mover/copiar y papelera | Implementado; probado con SQLite y esquemas PostgreSQL v1/v2 representativos |
| Cargas por partes, reintentos y reanudación | Implementado; probado con disco local |
| Descargas GET/HEAD, Range y ETag | Implementado; integridad entre partes cifradas comprobada |
| Reproducción original y permisos temporales por archivo | Implementado para cuenta y enlaces nuevos; revocación y rangos probados. Cada reproducción cuenta una descarga aunque solicite varios rangos |
| Pistas de audio/vídeo, conversión MP4/MP3 y subtítulos de texto | Implementado con FFprobe/FFmpeg opcionales; prueba real con dos vídeos y dos audios. Límites configurables. Falta incrustar subtítulos de imagen y descubrimiento DLNA en la red local |
| Canales y copias con mensajes independientes de Telegram | Implementado; falta validación real MTProto |
| Enlaces nuevos de lectura con contraseña, caducidad y límite | Implementado y probado localmente |
| TOML v1/v2 | Mapea los equivalentes implementados; entorno y extensiones node tienen prioridad |
| PostgreSQL v1/v2, archivos, partes, usuarios y canales | Adaptación directa; conserva IDs, roles, hashes y claves de contenido |
| Supabase por HTTPS 443 | RPC restringida y transacciones de escritura; probado con el catálogo real en lectura |
| Cifrado TELDRIVE/secretbox/scrypt y versiones de claves | Integridad y lectura por rangos probadas; falta vector Go y archivo real |
| Dashboard de almacenamiento | Uso actual, categorías, canales y actividad de subidas Node; sin reconstruir historial anterior |
| Bots v2, rotación y retorno a la cuenta ante errores | Lectura de los 26 bots existentes, cifrado XChaCha y una descarga real por bot validados; alta/baja implementadas, sin borrar ni crear bots reales durante las pruebas |
| Trabajos River/importaciones y SSE | Pendiente de port nativo |
| Spam de archivos propios | Implementado: revoca enlaces Node del árbol y permite restaurar sin reactivarlos |
| ACL entre usuarios, spam compartido y enlaces con edición | Pendiente; navegación oculta si el servidor no anuncia la capacidad |
| Búsqueda regex y generación de vistas previas persistentes | Pendiente |
| Sesiones web, enlaces, cargas, favoritos y estado de lectura ya emitidos por Go | No se importan; se conservan para uso con el motor original |

Se acepta el TOML completo sin divulgar secretos, pero parámetros de módulos pendientes como jobs y cachés no activan esas funciones en Node. `telegram.download-bots` configura el grupo de bots; 0 usa la cuenta. También se pueden ajustar en administración la cantidad de bots, intentos y espera tras fallos. El backend remoto de Go no se usa en modo nativo: Node conecta a Telegram directamente.

Los tokens existentes se leen con el formato `secureblob` de Go y la misma `security.data-key`. Node autentica claves MTProto propias por proceso y nunca abre ni sustituye las sesiones de Go. Las sesiones y esperas Node se guardan en metadatos separados por instancia (por defecto hostname y PID; se puede definir `TELEGRAM_INSTANCE_ID` único para un solo proceso). Los fallos de Node no deshabilitan bots del otro servicio. Registrar o eliminar un bot modifica el registro compartido, por lo que el cambio también aparece en Go. Las altas verifican la identidad y provisionan sus canales antes de habilitarlo; todavía no usan los trabajos River originales. El esquema legado v1 no importa sus bots automáticamente.

Las descargas resuelven canales mediante `channels.getChannels`, sin el límite de 200 chats ni `getDialogs` incompatible con bots. Los rangos se alinean a los bloques de Telegram y se recortan al rango HTTP solicitado. Si falla un bot después de entregar datos, el siguiente continúa desde el byte pendiente. El visor de audio/vídeo usa permisos temporales ligados a un archivo para que el vídeo pueda solicitar rangos sin depender de la cookie de acceso de 15 minutos. Su duración se puede ajustar en administración; los permisos se invalidan al revocar la sesión o el enlace correspondiente.

El acceso PostgreSQL usa un trabajador de I/O y una frontera síncrona para conservar transacciones. Está orientado a un proceso y carga moderada: filtra el catálogo en memoria y limita cada resultado a 32 MiB. No iguala el rendimiento del repositorio SQL paginado de Go. La concurrencia de transferencias se puede ajustar; ese ajuste no transforma esta arquitectura.

La pasarela MODE=gateway transmite las operaciones originales, streaming y WebSockets. Necesita el motor Go y no se combina automáticamente con el modo nativo.

Una migración completa es técnicamente posible con MTProto, PostgreSQL y trabajos durables en Node. Quedan los módulos indicados y pruebas de interoperabilidad reales. Esta versión debe evaluarse como un port inicial, conservando operativo el servicio original durante su validación.

El módulo multimedia reconoce `media.enabled`, `media.ffmpeg-path`, `media.ffprobe-path` y `media.max-concurrent`. Las rutas deben corresponder al sistema operativo del servidor; si se omiten, usa los paquetes fijados. Ejecuta `node scripts/install-media.mjs` después de instalar dependencias. Se pueden ajustar los procesos, hilos, resolución y tiempos en administración. El sondeo y las conversiones solo leen URLs del propio servidor con un permiso ligado al archivo. Los permisos por usuario y enlaces de edición siguen pendientes; la UI no consulta esas operaciones cuando el servidor no anuncia la capacidad.

La auditoría de 0.2.0 añade índices del árbol por operación, reutilización limitada de conexiones de bots, caché de recursos estáticos y recuperación del trabajador de Supabase tras un timeout. Consulta [AUDIT.md](AUDIT.md) para las correcciones, pruebas y límites que permanecen.

0.3.0 añade enlaces recuperables, permisos entre cuentas y tareas de mantenimiento de Node. Actualiza la RPC de Supabase antes de activar esta versión. Consulta [SHARING.md](SHARING.md) para comportamiento, límites e independencia respecto a permisos y tareas de Go.
