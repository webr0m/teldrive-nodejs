# Acceso de revisión a Teldrive Cloud

En Android 0.5.2 (502) y posteriores, la pantalla de acceso incluye **Explorar demostración**. No se necesita usuario, contraseña, código de Telegram, cuenta de Google ni un servidor accesible para utilizar la demo.

La demo utiliza las mismas pantallas del cliente con un transporte local separado. Permite explorar carpetas, buscar, ver imágenes y texto, reproducir un vídeo de ejemplo, crear carpetas, renombrar, copiar y mover archivos, usar la papelera, subir archivos temporales pequeños y seleccionar canales ficticios. Bots, sesiones y cuenta muestran ejemplos identificados como tales. La ayuda y el recorrido están disponibles.

Los datos viven en memoria y se restablecen al recargar. Las subidas de prueba tienen un máximo acumulado de 8 MB y 100 elementos; no se suben a Telegram ni a un servidor. Los enlaces públicos, la vinculación de Google y la administración real de bots requieren entrar con una cuenta real. Las peticiones no implementadas fallan dentro del transporte local y nunca se redirigen a la API real. La demo no cambia ni borra sesiones reales guardadas en el dispositivo.

Para salir, usar **Salir de la demo** en la franja informativa. Para revisar el acceso real, se necesita una cuenta de Telegram y sus códigos; Google solo funciona después de vincularlo explícitamente con una cuenta de Telegram autenticada recientemente.

## Instrucciones para Google Play

1. Abrir Teldrive Cloud 0.5.2 (código 502) o posterior.
2. En la pantalla inicial, pulsar **Explorar demostración**.
3. Omitir o completar el recorrido inicial. Usar Archivos, Compartidos, Ajustes y Más para recorrer las funciones.
4. Abrir **Bienvenido.txt** y **Vídeo de ejemplo.mp4** para comprobar las vistas previas. En Ajustes → Canales de Telegram se puede seleccionar un canal de ejemplo.
5. Las funciones que necesitan cuentas o servicios reales se identifican dentro de la demo; no utilizar credenciales privadas ni códigos de un tercero.

## Estado de publicación (15 de octubre de 2026)

- La versión 0.5.2 (502) está publicada en prueba interna e incorpora el acceso demo para revisión. Local y producción responden con Node 0.5.2-alpha.
- Ficha predeterminada preparada con descripción, icono, gráfico y cuatro capturas; privacidad, categoría/contacto, anuncios, funciones financieras y salud guardados.
- Público objetivo indicado por el editor: mayores de 18 años.
- Seguridad de datos preparada como borrador, con 15 tipos y sus finalidades; Google acepta las URLs públicas de eliminación en GitHub Pages. El guardado final depende de completar Público objetivo, que a su vez requiere Detalles de acceso.
- Las instrucciones demo están preparadas. La confirmación de acceso completo no se ha marcado: la demo no ejecuta la vinculación de cuentas, el aprovisionamiento real de bots ni enlaces públicos. No se debe afirmar que esos servicios se hayan probado sin una cuenta real.
- El editor aceptó los términos IARC e indicó que se prohíben desnudos y violencia gráfica real en enlaces públicos. La página de soporte publica esa política, con avisos por correo y revisión manual.
- Cuestionario IARC guardado: categoría de utilidad, interacción entre usuarios, contenido personal y sin catálogo editorial; las clasificaciones calculadas incluyen ESRB Todos y PEGI 3. Esto es independiente del público objetivo de mayores de 18 años indicado por el editor.
- El editor preparará una cuenta de Telegram exclusiva para revisión. Sigue pendiente un acceso reutilizable a las funciones reales de esa cuenta; no utilizar la cuenta personal del editor ni sus códigos para este fin.
- Beta abierta bloqueada por Google hasta obtener acceso a producción. La cuenta necesita una prueba cerrada con 12 participantes durante 14 días continuos; los 11 participantes adicionales se aportarán más adelante.
- AdMob: integración preparada, aplicación pendiente de revisión, anuncios reales desactivados. No se debe afirmar que hay monetización activa.
- iOS: compilación de simulador; falta la cuenta de App Store Connect y firma/distribución para dispositivos.

El vídeo y la imagen de demostración se generaron a partir de recursos del proyecto; no contienen datos de la unidad del editor.
