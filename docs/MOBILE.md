# Teldrive Cloud para Android e iOS

Cliente compartido React + Capacitor 8, con recursos incluidos en la aplicación. Conecta por HTTPS a `https://cloud.webrom.lat`; no ejecuta Node, rclone ni FUSE en el teléfono. El servidor sigue conservando sus funciones web. Android usa `lat.webrom.teldrive.client`, API mínima 24 y destino 36. iOS usa el mismo identificador y requiere macOS con Xcode 26 o posterior para compilar.

## Funciones

- Archivos, búsqueda, carpetas, subidas con reintentos, descarga mediante el guardado/compartir del sistema, lectores y reproducción según formatos admitidos.
- Compartidos propios y conmigo, enlaces reutilizables, papelera, spam y estadísticas de la cuenta.
- **Bots personales conservados**, selección del canal de la unidad, sesiones, apariencia, idioma y preferencias de subida. Sin rclone, montaje, claves de API, usuarios/permisos, creación/eliminación de canales, tareas del servidor ni sus límites.
- Navegación de aplicación con barra inferior: Archivos, Compartidos, Ajustes y Más. Ajustes agrupa las preferencias por cuenta, transferencias y ayuda; Más reúne las secciones secundarias sin repetir los accesos principales. La edición móvil no muestra vista dividida ni menús de escritorio.
- Diseño acotado a la pantalla, zonas seguras, teclados sin zoom automático de iOS, diálogos con desplazamiento y acciones de selección compactas. Verificado a 320×568, 390×844 y 844×390 con Chromium móvil y WebKit.
- Recorrido al primer acceso por cuenta, omitir/anterior/siguiente y repetición desde Ayuda. Manual buscable incluido en el paquete, accesible también desde el login (`/manual`) sin conexión al servidor.
- Sesiones nativas en Keychain/Android Keystore mediante Secure Storage; nunca en el almacenamiento web sin cifrar. Los medios y descargas usan permisos temporales para un archivo, sin poner el token de la cuenta en la URL.

La sesión móvil tiene alcance `client`, incluso para propietarios. La API vuelve a comprobar ese alcance y lo mantiene al renovar. Ocultar el menú no es la barrera de autorización. Las modificaciones afectan únicamente al cliente Node; los archivos y tablas originales de Teldrive siguen utilizándose de la misma forma.

## Compilación

```sh
pnpm install --frozen-lockfile
node scripts/build-mobile.mjs
# Android: JDK 21 y Android SDK 36
cd ui/android
./gradlew assembleDebug bundleRelease
# Windows: gradlew.bat
```

El script valida el origen HTTPS, compila a `ui/dist-mobile`, comprueba TypeScript y sincroniza ambos proyectos. Se puede pasar `android` o `ios` para sincronizar solo uno. `ui/.env.mobile.example` documenta las variables: expórtalas en el entorno de compilación. No se carga automáticamente ese archivo. La configuración del servidor es independiente en `.env` o `config.toml`.

El workflow **Mobile builds** produce APK de prueba, AAB sin firma de distribución y una aplicación para simulador iOS. El ZIP de simulador no es una IPA instalable en un iPhone. Android release se firma al proporcionar `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` y `ANDROID_KEY_PASSWORD`. Conserva el keystore y sus contraseñas en una copia privada; nunca los subas a Git. Los números de versión se controlan con `MOBILE_VERSION_CODE` y `MOBILE_VERSION_NAME`; en Xcode, con `CURRENT_PROJECT_VERSION` y `MARKETING_VERSION`.

## Google vinculado a Telegram

1. Crear un cliente OAuth de tipo **Web** en Google Cloud; registrar `https://cloud.webrom.lat/api/v1/mobile/google/callback` como URI de retorno exacta.
2. Configurar solo en el servidor `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` (TOML: `[node.google] client-id/client-secret`). Reiniciar Node. Nunca usar `VITE_*` para secretos.
3. Entrar con Telegram y abrir Cuenta → Vincular Google dentro de los diez minutos siguientes. Se vuelve a abrir Google en el navegador del sistema y se confirma esa cuenta. No se vincula por coincidencia de correo.
4. En accesos posteriores, «Continuar con Google» abre una sesión del mismo usuario de Telegram. Una cuenta de Google desconocida pide primero entrar con Telegram y vincularla. Desvincular exige un acceso reciente con Telegram y revoca las sesiones móviles de Google.

Usa código de autorización, PKCE en ambas etapas, estado, nonce, cookie de navegador y firma/audiencia/emisor/caducidad del ID token. Los estados caducan en diez minutos y se consumen una vez. No se guarda el token de Google. Los vínculos y flujos se cifran en `DATA_DIR/mobile/catalog.db`, fuera del esquema compartido con Go. Para migrar de servidor, copiar **todo DATA_DIR y conservar DATA_KEY**, además de la base compartida.

Google permanece desactivado si faltan las credenciales. Esto permite probar Telegram sin inventar una configuración OAuth.

## Canal de la unidad

En Ajustes → Canales de Telegram se puede elegir un canal registrado o buscar los canales administrables de la cuenta, importar uno y seleccionarlo. La selección se guarda en el servidor por usuario. Solo las subidas que empiecen después del cambio usarán el nuevo canal; los archivos anteriores no se trasladan ni se eliminan. La cuenta y sus bots deben conservar el acceso a los canales originales para leer los archivos anteriores.

La API móvil permite consultar, sincronizar canales descubiertos por Telegram y seleccionar un canal propio. Sigue rechazando la creación y eliminación de canales y el acceso a la administración del servidor. Las pruebas comprueban que no se puede seleccionar ni importar el canal de otro usuario. El manual y el recorrido incluidos explican esta función.

## Publicidad propia remota

Publicar un JSON HTTPS basado en [`examples/mobile-ads.json`](../examples/mobile-ads.json) y configurar `MOBILE_ADS_CONFIG_URL` en Node (`[node.mobile] ads-config-url`). El servidor solo entrega la URL; el cliente descarga el documento sin credenciales de la cuenta. El alojamiento del JSON debe permitir CORS para el origen nativo cuando corresponda. No se carga JavaScript ni HTML remoto.

`own.enabled` activa las campañas; `firstDelaySeconds` controla la primera aparición, `intervalSeconds` el intervalo posterior y `durationSeconds` su duración. El contador avanza cuando la app está visible y en una pantalla compatible. Los límites son 30 s–24 h entre anuncios, 5–120 s de duración, hasta 50 campañas y 64 KiB por manifiesto. `startsAt` y `endsAt` son fechas ISO opcionales. Solo se admiten imágenes y destinos HTTPS sin credenciales. Las campañas se alternan, pueden cerrarse y se pausan en diálogos, recorrido, login, configuración y lectores/reproductores. No aparecen dos banners a la vez.

`refreshSeconds` permite cambiar el manifiesto sin recompilar (entre 60 s y 24 h). Un error de descarga desactiva la publicidad hasta el siguiente intento. Para desactivarla globalmente, vaciar la URL o poner ambos `enabled` a `false`.

## AdMob

El modo predeterminado usa identificadores oficiales **de prueba**, sin ingresos. `admob.enabled` habilita el banner adaptativo nativo; los campos `androidBannerId` e `iosBannerId` son las unidades de cada plataforma. La aplicación inicializa el SDK y solicita anuncios únicamente después del flujo UMP y de `canRequestAds`. Pide anuncios no personalizados, no solicita ATT y ofrece revisar las opciones de privacidad desde Configuración. Las declaraciones de privacidad deben revisarse igualmente: los SDK publicitarios pueden recopilar datos aun con anuncios no personalizados.

Para monetizar una versión de distribución:

1. Registrar cada app en AdMob y crear una unidad de banner por plataforma. Configurar y publicar sus mensajes de privacidad UMP y el `app-ads.txt` del editor.
2. Poner las unidades en el JSON remoto. Compilar con `VITE_ADMOB_LIVE=true` y los IDs de aplicación `MOBILE_ADMOB_ANDROID_APP_ID` y `MOBILE_ADMOB_IOS_APP_ID` (contienen `~`, diferentes de las unidades que contienen `/`). El script rechaza identificadores de prueba en modo real.
3. Android toma el ID desde el entorno al ejecutar Gradle. En iOS pasar `ADMOB_APP_ID` a `xcodebuild` o configurarlo en ambos perfiles de Xcode; la plantilla incluye el identificador de prueba. La lista SKAdNetwork contiene Google y debe ampliarse si posteriormente se añade mediación.
4. Publicar política de privacidad y soporte del editor y configurar `MOBILE_PRIVACY_URL`/`MOBILE_SUPPORT_URL` en Node. No proporcionar un correo de contacto inventado ni declarar «no se recopilan datos».

## Auditoría y próximos pasos

| Prioridad | Resultado / mejora | Estado |
|---|---|---|
| Alta | Alcance móvil comprobado por API y conservado al renovar; propietario original intacto | Implementado y probado |
| Alta | Google sin autoasociación por email, con PKCE, nonce, firma, vínculo explícito y revocación | Implementado; prueba real pendiente de OAuth |
| Alta | Enlaces absolutos de compartir/reproducción/descarga y tickets por archivo para los lectores nativos | Corregido |
| Alta | Credenciales del cliente en almacén seguro, copia automática Android desactivada | Implementado; validar en dispositivos físicos |
| Alta | Retirada de banner al cerrar sesión, serialización de llamadas nativas y espacio reservado para no tapar subidas | Implementado; anuncios reales pendientes de IDs/UMP |
| Alta antes de publicación | Política, soporte, eliminación de datos/cuenta del cliente, ficha Data Safety/privacidad de Apple y acceso del revisor | Debe completarse con el editor; desvincular Google no equivale a eliminar los datos de la cuenta compartida |
| Alta antes de publicación | Revisar Apple 4.8 si Google se ofrece como login principal; evaluar Sign in with Apple o la excepción aplicable a clientes de terceros | Pendiente de revisión, sin prometer exención |
| Media | Carga diferida por pantallas, sin cargar administración/rclone al arrancar | Implementado |
| Media | Subidas duraderas en segundo plano con WorkManager/URLSession, reanudación tras cierre del proceso | Mejora futura; hoy mantener la app abierta durante las subidas |
| Media | Caché explícita sin conexión, selección de archivos favoritos y límites por dispositivo | Mejora futura; hoy el manual está incluido y solo las descargas elegidas se guardan |
| Media | Paginación SQL y consultas acotadas del catálogo en Supabase | Próxima optimización para unidades grandes; medir antes de modificar el esquema compartido |
| Media | Pruebas en dispositivos Android/iPhone: HEVC/HDR, subtítulos, audio múltiple, rotación, accesibilidad y red intermitente | Pendientes de hardware y firma |

Fuentes: [Capacitor 8](https://capacitorjs.com/docs/getting-started/environment-setup), [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect), [OAuth nativo](https://developers.google.com/identity/protocols/oauth2/native-app), [AdMob Android](https://developers.google.com/admob/android/privacy), [AdMob iOS](https://developers.google.com/admob/ios/privacy), [Apple 4.8](https://developer.apple.com/app-store/review/guidelines/#login-services), [carga diferida de TanStack](https://tanstack.com/router/latest/docs/guide/automatic-code-splitting).
