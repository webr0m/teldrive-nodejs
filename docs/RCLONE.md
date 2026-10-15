# Rclone y montaje persistente

Desde **Configuración → Rclone**, el control existente admite dos destinos independientes: **Servidor de Teldrive** y **Mi PC**. Cada destino guarda su propia conexión, transferencias, caché y montaje. El explorador de Teldrive Desktop se conserva para el cliente Windows anterior.

La integración usa [rclone-sdk](https://github.com/rclone-ui/rclone-sdk) con nuestra extensión [`@webr0m/rclone-teldrive`](../packages/rclone-teldrive/README.md) y el ejecutable [tgdrive/rclone v1.75.4](https://github.com/tgdrive/rclone/releases/tag/v1.75.4). El motor de rclone sigue escrito en Go; Node administra su API RC. El cliente antiguo que utiliza `access_token` no sirve para esta API con `api_key`.

## Servidor

1. Instala las dependencias e inicia `node scripts/install-rclone.mjs`. Descarga únicamente la release fijada de tgdrive/rclone y verifica su SHA256 contra el digest de su asset oficial. No reemplaza el rclone del sistema.
2. Crea una clave dedicada desde Configuración → Claves de API y escríbela en el formulario de Rclone.
3. Selecciona **Servidor de Teldrive** y pulsa **Guardar conexión en el servidor**. El control del servidor requiere una sesión de propietario o administrador; no acepta claves de API como credencial de administración.
4. Usa Archivos o Transferencias. Las descargas preparadas por rclone quedan en el área temporal privada de esa cuenta; puedes guardarlas en el navegador desde esa lista.

Los archivos temporales tienen una cuota por cuenta. El control web no puede explorar el resto del sistema de archivos ni ejecutar comandos RC arbitrarios. Los cambios a límites desde Administración se aplican al controlador del servidor.

## Mi PC

Con Node.js 22.13+ y las dependencias del proyecto instaladas, ejecuta desde su carpeta:

```sh
node scripts/install-rclone.mjs
node scripts/rclone-agent.mjs --url https://cloud.webrom.lat --show-pair-code
```

Selecciona **Mi PC (componente local)** en el mismo menú, introduce el código que muestra tu terminal y pulsa **Vincular este equipo**. Guarda luego la conexión con una clave de API dedicada. No compartas el código de vinculación: autoriza el control del componente local. El navegador lo conserva durante esta sesión de pestañas; el componente conserva sus credenciales y montajes aunque cierres el navegador.

El componente escucha solamente en `127.0.0.1:5573`. Exige su código en cada petición y acepta únicamente el origen de Teldrive indicado con `--url`. El navegador puede pedir permiso de red local. Si no lo admite, puedes seguir usando la extensión de Node o el cliente de escritorio. Para otro puerto configura `--port` y el mismo `RCLONE_AGENT_ORIGIN` en el servidor web; su política CSP permite solamente ese origen de loopback.

Las opciones `--data-dir`, `--executable`, `--port` y `--url` permiten mover el componente. Su carpeta debe ser privada: contiene la clave maestra local y el código de acceso. No se sincroniza con Supabase ni se publica en Git.

El componente también admite las variables `RCLONE_MAX_JOBS`, `RCLONE_MAX_CACHE_GIB`, `RCLONE_MAX_CACHE_HOURS`, `RCLONE_REQUEST_SECONDS` y `RCLONE_WORKSPACE_BYTES`. Guarda esos valores en su directorio privado para conservarlos al iniciarse con Windows.

## Montajes persistentes en ambos destinos

En la pestaña **Montajes persistentes**, elige letra de unidad cuando estés en Windows, tamaño máximo de caché, retención, modo de solo lectura e inicio automático. **Guardar montaje persistente** conserva la intención; **Montar ahora** aplica y monta. El estado diferencia una configuración guardada de una unidad realmente montada. **Desmontar y desactivar inicio automático** desmonta y desactiva su restauración.

En Windows se necesita WinFsp. **Iniciar componente con Windows** crea un iniciador oculto para el usuario actual en su carpeta Inicio; **Desactivar inicio con Windows** elimina solo ese iniciador. Al iniciar el componente, se recuperan los montajes marcados como automáticos. En un servidor, Node recupera los montajes cuando inicia la aplicación y vuelve a comprobarlos cada diez segundos. Para arrancar al reiniciar un VPS, administra Node con tu supervisor habitual. Passenger activa la aplicación según su ciclo de vida; no garantiza iniciarla en el momento de encender el sistema.

La caché VFS conserva su ruta entre reinicios. No elimines esa carpeta si contiene escrituras pendientes. El control rechaza el desmontaje mientras rclone informa subidas en cola o en progreso. El máximo de caché es un objetivo de rclone: archivos abiertos o escrituras pendientes pueden excederlo temporalmente.

En el hosting Namecheap actual **no hay acceso a `/dev/fuse` ni un montador FUSE disponible**. Allí funcionan las transferencias; el montaje se puede dejar configurado para una futura migración. No se puede habilitar ese controlador desde Node en un hosting compartido. El mismo código detecta WinFsp/FUSE en el nuevo equipo y permite montarlo allí.

## Persistencia, procesos y límites

El estado del controlador se guarda en `DATA_DIR/rclone/catalog.db`, separado de las tablas compartidas con Go. Las claves y la conexión al daemon están cifradas con `DATA_KEY`; el rclone administrado mantiene su configuración en memoria. Guarda ese estado y su clave al migrar. Cada cuenta utiliza un daemon privado con autenticación aleatoria y loopback. Otro proceso Passenger puede reconectar al daemon mediante ese estado cifrado. Una reserva SQLite evita arranques simultáneos durante la apertura del remoto.

Las transferencias terminadas conservan su estado consultado. Si un proceso desaparece antes de completar una transferencia, esta se marca interrumpida y se puede reintentar; no se afirma que toda transferencia se reanude automáticamente después de reiniciar el equipo. Los montajes automáticos sí vuelven a iniciarse. La cuenta debe seguir habilitada y conservar permisos de administración para mantener un montaje del servidor.

Variables y equivalentes TOML:

| Variable | TOML | Función |
| --- | --- | --- |
| `RCLONE_EXECUTABLE` | `node.rclone.executable` | Ejecutable compatible; por defecto `var/tools/rclone/...` |
| `RCLONE_MOUNT_ROOT` | `node.rclone.mount-root` | Raíz de montajes del servidor |
| `RCLONE_MOUNT_ENABLED` | `node.rclone.mount-enabled` | Permitir montaje cuando existe controlador |
| `RCLONE_AGENT_ORIGIN` | `node.rclone.agent-origin` | Origen de loopback permitido por la web |
| `RCLONE_MAX_JOBS` | `node.limits.rclone-max-jobs` | Transferencias simultáneas por cuenta |
| `RCLONE_MAX_CACHE_GIB` | `node.limits.rclone-max-cache-gib` | Tope configurable por montaje |
| `RCLONE_MAX_CACHE_HOURS` | `node.limits.rclone-max-cache-hours` | Tope de retención de caché |
| `RCLONE_REQUEST_SECONDS` | `node.limits.rclone-request-seconds` | Espera de consultas al daemon |
| `RCLONE_WORKSPACE_BYTES` | `node.limits.rclone-workspace-bytes` | Cuota del área temporal por cuenta |

## Compatibilidad corregida

El servidor acepta MIME con parámetros, como `text/plain; charset=utf-8`. Para nuevas subidas calcula el hash de Teldrive: BLAKE3 de cada bloque de 16 MiB y BLAKE3 de los digests concatenados. Las partes alineadas reutilizan sus hashes sin descargar otra vez desde Telegram. Las sesiones anteriores conservan su contrato hasta completarse o caducar.

La papelera se lista por carpeta de forma predeterminada para el recorrido de rclone; `scope=drive` selecciona todos los archivos en papelera o spam. La UI usa explícitamente ese ámbito. Así se evitan duplicados al recorrer carpetas.

La prueba con el ejecutable real cubre listas, subidas cifradas de varias partes, hash contrastado con Go, descarga íntegra, rangos, trabajos asíncronos, copia, movimiento, enlaces reutilizables y papelera. En Windows con WinFsp se comprueban además montaje, lectura, recuperación tras reinicio del controlador y desmontaje. Las pruebas locales utilizan almacenamiento de prueba; no trasladan archivos del usuario.
