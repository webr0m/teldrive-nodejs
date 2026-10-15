# Enlaces, acceso entre cuentas y tareas en 0.3.0

El diálogo Compartir muestra los enlaces existentes con su dirección y un botón Copiar enlace. Cerrar el diálogo, recargar o reiniciar el servidor no pierde la dirección. Si existe un enlace vigente, el diálogo permite copiarlo; no genera otro. La API también reutiliza el registro cuando se repiten archivo, contraseña, vencimiento y límite de descargas. Los vencidos, agotados o revocados no se reactivan.

Las direcciones recuperables usan HMAC-SHA256 con `DATA_KEY`, un propósito separado, propietario e identificador del registro. No se guardan tokens en texto claro. Se debe conservar la misma `DATA_KEY` al migrar. Para los registros anteriores que solo guardaban una huella, no es posible reconstruir la dirección original: se proporciona una dirección estable para el mismo registro. La dirección antigua sigue funcionando y ambas respetan contraseña, vencimiento, cupo y revocación.

Compartido conmigo admite permisos de lectura y edición heredados por las carpetas. El lector puede abrir y descargar; el editor también puede crear carpetas, subir, renombrar y enviar elementos a la papelera. El propietario administra los permisos y enlaces públicos. Las nuevas subidas siguen perteneciendo al propietario de la carpeta, y los estados de lectura permanecen separados por usuario. No se permite usar una carpeta recibida para listar el resto de la unidad del propietario. Revocar un permiso bloquea nuevas lecturas y los permisos de reproducción emitidos a esa cuenta.

Spam distingue los elementos propios y los recibidos. Enviar un elemento recibido a Spam no modifica el original; restaurarlo devuelve el acceso y retirarlo revoca los permisos directos de esa cuenta. Poner un elemento propio en Spam revoca sus enlaces y permisos de Node. Corregida la espera infinita causada por consultar `isPending` en una consulta desactivada.

Tareas admite mantenimiento nativo de Node: limpiar sesiones de subida vencidas y purgar archivos con estado `deletion_pending` cuya retención haya vencido. No elimina archivos activos ni la papelera por el mero hecho de abrir la página. Hay detalle, estados, pausa de colas, cancelación, reintento, estadísticas y lotes limitados. Una reserva atómica en la base impide ejecutar la misma tarea desde dos procesos de Passenger. La reserva se renueva y un reinicio permite recuperar tareas interrumpidas. Las tareas se crean y consultan por cuenta administradora.

Los límites `JOB_POLL_SECONDS`, `JOB_LEASE_SECONDS`, `JOB_BATCH_LIMIT` y `PENDING_RETENTION_DAYS` se configuran en administración, entorno o `[node.limits]` del TOML. El valor inicial de retención es 30 días. Al publicar esta versión sobre Supabase se debe instalar la nueva `db/supabase-rpc.sql`, que mantiene la función restringida a `service_role` y añade los registros de permisos, tareas y colas de Node.

Los permisos y tareas de Node se guardan en `teldrive_node`; todavía no se importan los permisos ni el historial de River del servidor Go. Las tablas de archivos, usuarios, canales y partes siguen siendo las mismas. La interoperabilidad de permisos y tareas con Go y las tareas periódicas quedan pendientes; no se presentan como implementadas.

El inicio de sesión usa un formulario: Enter envía teléfono, código o contraseña según el paso actual, con protección contra envíos simultáneos y campos vacíos.
