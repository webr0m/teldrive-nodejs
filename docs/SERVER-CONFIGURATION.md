# Configuración privada del servidor

Solo el propietario puede abrir **Configuración → Configuración del servidor**, **Límites del servidor** y **Usuarios y permisos**. La API comprueba el ID numérico de Telegram configurado en `OWNER_USER_ID`; no confía en el nombre de usuario del navegador. Con un propietario configurado, la primera cuenta visitante siempre es un usuario normal. Los administradores conservan sus tareas, pero no estos controles. Las sesiones móviles tienen alcance de cliente y tampoco acceden a ellos.

El editor importa TOML v1/v2 o permite pegar y editar sus equivalentes implementados. Es la alternativa privada a un Gist: no publica secretos, no depende de una URL compartida ni descarga configuración de terceros. Requiere una sesión web del propietario autenticada con Telegram; las claves de API no sirven para editar credenciales. El archivo se guarda en el hosting con permisos `0600`, respaldos privados, control de versión y reemplazo atómico. No añadas este archivo ni sus respaldos a Git.

## Activación y prioridad

`SERVER_CONFIG_FILE=./config.admin.toml` define una ruta estable **fuera de `STATIC_DIR`**. El valor `none` desactiva el editor. La prioridad al arrancar es: TOML original → variables de entorno → archivo privado del editor. `CONFIG_FILE=none` desactiva la lectura de TOML original y, si no hay `SERVER_CONFIG_FILE` explícito, también el editor (por ejemplo en pruebas y demo local).

Se admiten los nombres de [config.sample.toml](../config.sample.toml); también `node.database-url` para la conexión PostgreSQL. El editor muestra los parámetros configurados y permite añadir los compatibles del ejemplo. Los campos omitidos se conservan, `''` borra un valor y `__TELDRIVE_KEEP_SECRET__` conserva un secreto oculto. No reemplaces ese marcador salvo que quieras cambiar la credencial. Validar un TOML v1/v2 informa de las opciones sin soporte; debes aceptar omitirlas antes de guardar. No se incorporan módulos de Go por incluir sus claves.

`OWNER_USER_ID`, claves de cifrado y keyring, directorios de datos y parámetros de arranque quedan protegidos. Se cambian desde el hosting con un procedimiento específico y respaldos. Nunca cambies una clave para resolver un problema de conexión: podrías perder acceso a sesiones o archivos cifrados.

Los límites guardados en **Límites del servidor** siguen teniendo prioridad sobre sus valores iniciales del TOML. Se aplican a nuevas operaciones sin reiniciar; el editor de configuración dura requiere reiniciar.

## Cambiar de base de datos

1. Prepara el destino y respalda el origen. El editor **no copia datos, tablas ni archivos de Telegram**.
2. Importa o edita la conexión, el transporte y los esquemas compatibles. Para PostgreSQL usa `node.database-url`, `node.database-transport='postgres'` y el diseño apropiado. Para HTTPS Supabase configura `node.supabase-url`, `node.supabase-key` y `node.database-transport='supabase'`; el destino debe tener el esquema v2 y el RPC restringido instalado según [SUPABASE.md](SUPABASE.md).
3. Pulsa **Validar TOML**. Esto comprueba sintaxis y combinación de parámetros **sin conectarse al destino**. Confirma que preparaste el destino y el respaldo, y guarda.
4. Reinicia. En Passenger configura `SERVER_RESTART_FILE=./tmp/restart.txt` para habilitar **Reiniciar aplicación**. En otros servidores usa su gestor de servicios. Las transferencias activas pueden interrumpirse.
5. Comprueba `/api/health/ready`, acceso y archivos antes de aceptar nuevas escrituras. Mantén detenida la instancia anterior durante una migración con copia para evitar divergencias.

## Recuperación

Cada guardado respalda la versión previa en `config.admin.toml.backups`, directorio `0700`. El panel ofrece las últimas 20 copias; los archivos anteriores se conservan para recuperación manual. Restaurar crea otro respaldo y requiere reiniciar. No restaura la base de datos ni revierte escrituras hechas después de cambiar de conexión.

Si una conexión nueva impide arrancar, el panel tampoco estará disponible: desde cPanel restaura el archivo privado con una copia anterior (o renómbralo para volver a TOML/entorno) y reinicia. Conserva los permisos privados. Si una caída deja `config.admin.toml.lock`, confirma que no hay una escritura activa antes de retirarlo desde el hosting.

**Privacidad y publicidad** es una preferencia del cliente Android/iOS: se ofrece únicamente dentro de la app nativa. Las políticas públicas de privacidad y soporte siguen disponibles para todos.
