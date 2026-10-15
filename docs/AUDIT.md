# Auditoría de 0.2.0-alpha

## Correcciones y optimizaciones

- Catálogo: índices de hijos y estados por operación. Rutas de carpetas y dashboard hacen una sola lectura del catálogo; recorridos profundos iterativos, sin recursión ni barridos repetidos. Las búsquedas incluyen la ruta de la carpeta contenedora.
- Enlaces: validar un archivo dentro de un enlace recorre sus ancestros y evita cargar toda la unidad en cada rango de reproducción. Las listas compartidas reutilizan el índice del árbol.
- Telegram: grupo acotado de conexiones de bots con claves exclusivas de Node. Reutiliza conexiones inactivas, caduca las ociosas y las cierra al parar; respeta el número configurado y nunca usa la sesión de Go.
- Limpieza: un lote de hasta 100 registros comparte el índice de referencias. Conserva las partes usadas por otros archivos y usuarios.
- Subidas: renovación de acceso también en XMLHttpRequest, reintentos acotados para 429/503 o fallos de red, cancelación durante las esperas, límite de concurrencia anunciado por el servidor y protección al reanudar rápidamente una tarea. Combinar carpetas existentes usa búsqueda de texto con coincidencia exacta, compatible con Node.
- Interfaz: clic derecho en filas o tarjetas, selección múltiple y Shift+F10. Las acciones usan los mismos diálogos y operaciones existentes. Los menús cierran antes de navegar a configuración y el diseño obtiene el perfil de la consulta compartida.
- Papelera: incluye elementos eliminados en carpetas anidadas. Spam propio restaura archivos y revoca los enlaces creados por Node de todo el árbol; restaurar no reactiva esos enlaces.
- Sesiones: se comprueba el vencimiento absoluto además del vencimiento del token de acceso.
- Supabase: un timeout reemplaza trabajador y buffers compartidos; una respuesta tardía no puede mezclarse con la consulta siguiente. PostgreSQL deja de esperar repetidamente sobre un trabajador ya perdido.
- Recursos web: caché de memoria acotada, ETag/304 y caché pública prolongada para archivos con nombre versionado. HTML y API conservan `no-store`.
- Capacidades: se evita consultar ACL y spam recibido en servidores que no implementan esas operaciones. «Dejar de compartir» revoca los enlaces Node aunque no exista la API de permisos entre cuentas.

## Configuración portable

Los límites nuevos se pueden ajustar en administración, variables de entorno o `[node.limits]` del TOML:

| Variable | Valor inicial |
| --- | --- |
| `BOT_CLIENT_POOL_SIZE` | 2; 0 desactiva la reutilización |
| `BOT_CLIENT_IDLE_SECONDS` | 30 |
| `UPLOAD_RETRY_ATTEMPTS` | 5 |
| `STATIC_CACHE_BYTES` | 16777216; 0 desactiva la caché |

## Validación

Pruebas automatizadas de árboles de 12000 niveles, ciclos y archivos huérfanos; consultas del catálogo; limpieza con referencias entre cuentas; timeout y reinicio de Supabase; expiración de sesiones; aislamiento y reutilización de bots; MP4/selección de pistas; cancelación con contrapresión; reintentos y renovación de subidas; recursos estáticos y ETag. También se comprueban tipos y compilación de la UI, y se revisan los menús y navegación con el navegador.

## Límites pendientes

El acceso a la base conserva una frontera síncrona y resultados de hasta 32 MiB; los listados aún cargan el catálogo del usuario antes de paginar. La paginación SQL y una conversión asíncrona del repositorio requieren otra etapa. No se afirma equivalencia completa con Go: siguen pendientes ACL entre cuentas, trabajos/importaciones River, SSE, regex y subtítulos de imagen. Los enlaces y permisos emitidos por Go se conservan separados. La compatibilidad completa del cliente rclone requiere validación específica.

La reutilización de conexiones reduce reconexiones; la velocidad final sigue dependiendo de Telegram, Supabase, el códec y los recursos del hosting. Una prueba de arranque de un vídeo no certifica la reproducción completa de todas las películas.
