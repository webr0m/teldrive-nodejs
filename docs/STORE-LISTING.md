# Ficha preparada: Teldrive Cloud

Nombre elegido en Google Play: **Teldrive Cloud**. Idioma: español de Latinoamérica. Aplicación gratuita con publicidad configurable. Paquete propuesto: `lat.webrom.teldrive.client` (verificar contra Play Console antes de la primera carga).

Descripción corta propuesta:

> Organiza, comparte y reproduce tus archivos de Telegram desde el móvil.

Descripción completa propuesta:

> Teldrive Cloud es un cliente para acceder a tu unidad Teldrive desde Android e iOS. Necesitas una cuenta de Telegram y acceso a un servidor Teldrive Node compatible.
>
> Explora carpetas, busca archivos, sube documentos y comparte enlaces reutilizables. Abre imágenes, documentos y libros compatibles, reproduce tus vídeos y gestiona los bots de tu propia cuenta. Puedes consultar los archivos compartidos contigo, recuperar elementos de la papelera y ajustar la apariencia y las preferencias del cliente.
>
> Un recorrido inicial y un manual integrado te ayudan a conocer las funciones. El acceso con Google está disponible cuando el editor configura la integración y vinculas expresamente tu cuenta con Telegram.
>
> La reproducción depende de los formatos del dispositivo y de las funciones habilitadas en el servidor. Mantén la aplicación abierta durante las subidas. La aplicación puede mostrar publicidad de AdMob y banners propios del editor.
>
> Teldrive Cloud es un cliente independiente y no está afiliado a Telegram.

Categoría propuesta: Productividad. Sin compra integrada ni suscripción implementada. No declarar almacenamiento sin límites, copias sin conexión automáticas ni subidas garantizadas en segundo plano.

## Antes de enviar a revisión

- Confirmar nombre, paquete, titular del contenido y marca. No reutilizar capturas de otra aplicación: generar capturas de esta versión con archivos de prueba.
- Completar políticas de privacidad y datos, soporte y eliminación de cuenta/datos con información real del editor. [Google explica los requisitos de eliminación](https://support.google.com/googleplay/android-developer/answer/13327111).
- Declarar anuncios y los datos recopilados por SDKs. [Google Mobile Ads: divulgación de datos](https://developers.google.com/admob/android/privacy/play-data-disclosure). Revisar también [privacidad de apps de Apple](https://developer.apple.com/app-store/app-privacy-details/).
- Completar clasificación de contenido, público objetivo, políticas aplicables al contenido generado por usuarios y derechos de acceso. No inventar respuestas de cumplimiento.
- Dar al revisor un acceso válido sin depender de un código personal de Telegram que caduque. El acceso está limitado por `ALLOWED_USERS`; no abrir el servidor a todo el público para resolver este requisito.
- Android: conservar la clave de subida, firmar el AAB, comprobar package/versionCode y usar primero prueba interna. La consola de esta cuenta exige una prueba cerrada de 12 participantes durante 14 días antes de solicitar producción ([requisitos de Google](https://support.google.com/googleplay/android-developer/answer/14151465)).
- iOS: completar Apple Developer/App Store Connect, Bundle ID, equipo, firma y perfil; producir un archive/IPA de distribución y subirlo a TestFlight. El ZIP de simulador sirve para validación, no para subirlo a la tienda.
- El propietario debe responder las declaraciones de exportación/encriptación. No se predeclara una exención en `Info.plist`.

La ficha creada, un archivo cargado, una prueba interna y una publicación pública son estados diferentes. Registrar el resultado real de cada paso.
