# Crear bots desde Configuración → Bots

Cada usuario elige un bot administrador para sus propios bots. Esta selección no otorga permisos administrativos sobre Teldrive ni permite administrar los bots de otras cuentas.

## Preparar una vez el administrador

1. En BotFather, crea o elige un bot de tu cuenta y activa **Bot Management Mode** en sus ajustes.
2. Abre **Configuración → Bots → Vincular bots existentes** e introduce su token. El token se verifica, se cifra en el servidor y no vuelve a mostrarse. Esta vinculación conserva el funcionamiento existente de los bots de transferencia.
3. En esa misma página, abre **Crear bots desde Teldrive → Configurar bot administrador** y selecciona el bot.
4. Pulsa **Verificar y guardar administrador**. Teldrive comprueba la propiedad con tu sesión de Telegram y comprueba el modo de administración con el propio bot. Un fallo no reemplaza la selección anterior.

Cambiar o quitar esta selección no elimina bots ni revoca tokens en Telegram. La creación de un bot es una acción distinta de cambiar el administrador seleccionado. Los bots anteriores conservan su administrador original en Telegram.

## Crear un bot de almacenamiento

Introduce su nombre y un usuario disponible de 5–32 caracteres terminado en `bot`. Elige uno de tus canales privados configurados. La cuenta necesita poder añadir administradores en ese canal.

Al pulsar **Crear bot y configurar canal**, Teldrive utiliza `bots.createBot` con tu sesión personal en el servidor principal. El bot pertenece a esa cuenta de Telegram y el administrador elegido también puede gestionarlo. El administrador obtiene el token mediante `bots.exportBotToken` con `revoke: false`; no se rotan credenciales existentes. El token se cifra con el formato de Teldrive y no se entrega al navegador.

El nuevo bot recibe permisos de publicación, edición y eliminación en el canal elegido. El registro por canal evita asignar ese bot a transferencias de otros canales a los que no tiene acceso. Los bots vinculados con el mecanismo anterior mantienen su alcance existente. El servidor respeta los límites y las esperas que devuelve Telegram.

Si Telegram ya creó el bot pero falló el paso de configuración, la respuesta informa que está pendiente. La misma página muestra **Preparar reintento**, incluso después de recargar. Conserva el usuario del bot para completar su configuración: se consultan primero los bots que Telegram atribuye a tu cuenta, evitando crear otro tras perder una respuesta o repetir una petición.

## Servidores y clientes

La interfaz es compartida por la web y los clientes Android/iOS. Las sesiones de cliente pueden administrar sus propios bots, sin obtener acceso a usuarios, permisos, límites o credenciales del servidor.

El portal del PC reenvía estas operaciones al servidor principal. El nodo de medios mantiene sus claves independientes de bots y nunca abre una segunda copia de la sesión personal. El balanceador sigue limitándose a lecturas de medios.

No se añaden tablas ni se modifica el esquema original de Teldrive. La selección y los estados de recuperación se guardan como registros propios en el bucket `settings`. Los canales asignados usan `bot-state`, aprovechando la consulta que ya realiza el selector de bots para evitar otra petición HTTPS en cada transferencia. Ambos buckets ya están permitidos por PostgreSQL y la RPC HTTPS de Supabase. Los tokens permanecen en la tabla de bots con su cifrado existente.

## API

- `GET /api/v1/bots/manager`: selección de la cuenta y configuraciones pendientes, sin credenciales.
- `POST /api/v1/bots/manager`: selecciona y verifica `{ "botId": 12345 }`.
- `DELETE /api/v1/bots/manager`: quita la selección de esa cuenta; no borra el bot.
- `POST /api/v1/bots/managed/check-username`: valida `{ "username": "mi_unidad_bot" }`.
- `POST /api/v1/bots/managed`: crea o recupera `{ "name": "Mi unidad", "username": "mi_unidad_bot", "channelId": "123456" }`. Devuelve 201 cuando queda listo y 202 si existe y falta completar su configuración. La interfaz usa una clave de idempotencia nueva para un reintento explícito de una configuración pendiente.

Todos requieren autenticación y se limitan a los recursos de la cuenta. El contrato está en `openapi/teldrive.openapi.yaml`.

Referencias oficiales: [bots administrados](https://core.telegram.org/api/bots/managed-bots), [configurar Bot Management Mode](https://core.telegram.org/bots/features#managed-bots), [bots.createBot](https://core.telegram.org/method/bots.createBot).
