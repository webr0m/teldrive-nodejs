# Teldrive drive for rclone-sdk

Extensión para [rclone-sdk](https://github.com/rclone-ui/rclone-sdk) que añade una conexión a Teldrive v2 y a [Teldrive Node](https://github.com/webr0m/teldrive-nodejs), con claves de API. Se usa desde un servidor Node.js, una aplicación de escritorio o un proceso de automatización.

El motor de transferencias sigue siendo rclone. Usa el ejecutable de **[tgdrive/rclone v1.75.4](https://github.com/tgdrive/rclone/releases/tag/v1.75.4)** que incluye el backend `teldrive` con `api_key`. El rclone estándar y los clientes antiguos con `access_token` no sirven para este backend. La extensión verifica esta capacidad antes de guardar la conexión.

## Instalación

Requiere Node.js 22.13 o posterior. Desde el repositorio:

```sh
pnpm install --frozen-lockfile
```

Para otro proyecto, instala el archivo `webr0m-rclone-teldrive-0.1.0.tgz` de los assets de la release de Teldrive Node:

```sh
npm install ./webr0m-rclone-teldrive-0.1.0.tgz
```

El paquete no está publicado en el registro npm. Incluye JavaScript ESM y tipos TypeScript; no necesita compilación. Descarga el ejecutable compatible desde la release de tgdrive/rclone para tu sistema operativo. No se descarga ni se ejecuta ningún binario durante `npm install`.

## Daemon administrado por Node

```js
import { startTeldriveRclone } from '@webr0m/rclone-teldrive';

const drive = await startTeldriveRclone({
  executable: process.env.RCLONE_EXECUTABLE, // ruta del ejecutable compatible
  apiHost: 'https://cloud.webrom.lat',
  apiKey: process.env.TELDRIVE_API_KEY,
  chunkMiB: 64,
  concurrency: 2,
  encrypt: false,
  hash: true,
});
try {
  console.log((await drive.list()).list);
  await drive.mkdir('Respaldo');
  const job = await drive.upload('./informe.pdf', 'Respaldo/informe.pdf', { async: true });
  await drive.waitJob(job.jobid);
  await drive.download('Respaldo/informe.pdf', './descargado.pdf');
  console.log((await drive.link('Respaldo/informe.pdf')).url);
} finally {
  await drive.close();
}
```

Cada instancia arranca un proceso aislado, escucha únicamente en `127.0.0.1` con puerto aleatorio y autenticación aleatoria, y utiliza la configuración de rclone en memoria. `close()` termina ese proceso y elimina su directorio temporal. Llama a `close()` al apagar tu aplicación. No modifica el rclone global ni tus remotos existentes. `cacheDirectory` permite conservar la caché VFS entre reinicios.

## Añadir Teldrive a un rclone-sdk existente

```js
import { createRCDClient, createTeldriveRemote } from '@webr0m/rclone-teldrive';

const rcd = createRCDClient({
  baseUrl: 'http://127.0.0.1:5572',
  headers: { Authorization: process.env.RCLONE_RC_AUTHORIZATION },
});
const drive = await createTeldriveRemote(rcd, {
  name: 'teldrive-node',
  apiHost: process.env.TELDRIVE_URL,
  apiKey: process.env.TELDRIVE_API_KEY,
});
console.log((await drive.list('Documentos', { hashes: true })).list);
await drive.dispose(); // elimina solo este remoto, conserva el daemon del llamador
```

El daemon externo necesita el mismo backend compatible. La extensión rechaza un nombre ya existente para no sobrescribir otra conexión. Guarda la clave mediante un cuerpo JSON, fuera de la URL. El archivo de configuración del daemon externo queda bajo responsabilidad de quien lo administra.

## Operaciones

| Método | Función |
| --- | --- |
| `list`, `stat`, `mkdir` | Explorar y crear carpetas |
| `upload`, `download` | Transferir archivos entre Node y Teldrive |
| `copy`, `move` | Copiar o mover archivos dentro del drive |
| `link` | Obtener un enlace público reutilizable |
| `remove`, `trash`, `restore` | Enviar un archivo a papelera, listar y restaurar por ID |
| `jobStatus`, `waitJob`, `stopJob` | Consultar, esperar o cancelar transferencias asíncronas |
| `rcd` | Acceder al cliente rclone-sdk original y sus demás operaciones |

`chunkMiB`, `concurrency`, `encrypt`, `hash` y `pageSize` son configurables. El servidor conserva sus propios límites de tamaño y concurrencia desde Administración. Las rutas del drive son relativas a su raíz; no aceptan `..`. Las rutas locales se resuelven en el equipo donde corre Node.

## Uso con una web y Namecheap

Ejecuta esta extensión en el **backend Node**, conserva la clave allí y expón a la web solo las acciones y destinos que autorices. El RC completo puede leer archivos del servidor: no lo publiques ni envíes sus credenciales al navegador. Un servidor web puede mostrar el progreso consultando `jobStatus` mediante su propia API autenticada.

Namecheap sigue sirviendo Teldrive a los clientes por HTTPS; no necesita un daemon adicional para que un Node externo se conecte. Para ejecutar transferencias entre nubes *en el hosting*, este debe permitir el ejecutable y procesos de larga duración. Passenger puede reiniciar su aplicación: en un VPS utiliza un supervisor y un daemon RC persistente, o gestiona la reanudación de trabajos al reiniciar. Esta extensión no monta unidades desde un navegador; el montaje requiere FUSE/WinFsp en el equipo que ejecuta rclone.

## Licencia y procedencia

MIT. Adaptador propio para la API pública de `rclone-sdk` (MIT), basada en `rclone/rclone-openapi`. El ejecutable tgdrive/rclone se distribuye por separado conforme a su propia licencia. No es un port del motor Go a JavaScript.
