# Estado del port

Referencia: [webr0m/teldrive, teldrive-v2-drive-es](https://github.com/webr0m/teldrive/tree/teldrive-v2-drive-es), commit e970c75502711abccdfe57c7fe2ae8961c5ed1d1. Se conservan su interfaz React, localización y contrato generado. También se ofrece una adaptación del esquema UUID v1 de main, commit c12a1da.

**El motor Node es una versión inicial; conservar toda la interfaz no equivale a haber portado todas las operaciones del motor Go.**

| Función | Estado nativo |
| --- | --- |
| Interfaz personalizada, temas, traducciones y visores | Compila; revisión visual contra tel.webrom.lat |
| Límites persistentes dentro de la configuración original | Implementado y probado |
| Acceso Telegram por teléfono, 2FA y QR | Implementado; pendiente prueba real |
| Sesiones, renovación, claves API, roles y administración | Implementado; ciclo local probado |
| Carpetas, búsqueda de texto, favoritos, mover/copiar y papelera | Implementado; probado con SQLite y esquemas PostgreSQL v1/v2 representativos |
| Cargas por partes, reintentos y reanudación | Implementado; probado con disco local |
| Descargas GET/HEAD, Range y ETag | Implementado; integridad entre partes cifradas comprobada |
| Canales y copias con mensajes independientes de Telegram | Implementado; falta validación real MTProto |
| Enlaces nuevos de lectura con contraseña, caducidad y límite | Implementado y probado localmente |
| TOML v1/v2 | Mapea los equivalentes implementados; entorno y extensiones node tienen prioridad |
| PostgreSQL v1/v2, archivos, partes, usuarios y canales | Adaptación directa; conserva IDs, roles, hashes y claves de contenido |
| Supabase por HTTPS 443 | RPC restringida y transacciones de escritura; probado con el catálogo real en lectura |
| Cifrado TELDRIVE/secretbox/scrypt y versiones de claves | Integridad y lectura por rangos probadas; falta vector Go y archivo real |
| Dashboard de almacenamiento | Uso actual, categorías, canales y actividad de subidas Node; sin reconstruir historial anterior |
| Bots, rotación, trabajos River/importaciones y SSE | Pendiente de port nativo |
| ACL entre usuarios, spam compartido y enlaces con edición | Pendiente |
| Búsqueda regex, generación de vistas previas y transcodificación | Pendiente |
| Sesiones web, enlaces, cargas, favoritos y estado de lectura ya emitidos por Go | No se importan; se conservan para uso con el motor original |

Se acepta el TOML completo sin divulgar secretos, pero parámetros de módulos pendientes como jobs, media, cachés y selección de bots no activan esas funciones en Node. El backend remoto de Go no se usa en modo nativo: Node conecta a Telegram directamente.

El acceso PostgreSQL usa un trabajador de I/O y una frontera síncrona para conservar transacciones. Está orientado a un proceso y carga moderada: filtra el catálogo en memoria y limita cada resultado a 32 MiB. No iguala el rendimiento del repositorio SQL paginado de Go. La concurrencia de transferencias se puede ajustar; ese ajuste no transforma esta arquitectura.

La pasarela MODE=gateway transmite las operaciones originales, streaming y WebSockets. Necesita el motor Go y no se combina automáticamente con el modo nativo.

Una migración completa es técnicamente posible con MTProto, PostgreSQL y trabajos durables en Node. Quedan los módulos indicados y pruebas de interoperabilidad reales. Esta versión debe evaluarse como un port inicial, conservando operativo el servicio original durante su validación.
