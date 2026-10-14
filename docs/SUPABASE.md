# PostgreSQL por HTTPS desde hosting compartido

`DATABASE_TRANSPORT=supabase` usa HTTPS 443 y la Data API de Supabase. `DATABASE_TRANSPORT=postgres` mantiene el acceso SQL directo. Ambos usan el mismo catálogo v2; cambiar el transporte no duplica ni migra los archivos.

1. Respalda la base. Con una conexión PostgreSQL permitida, revisa e instala `db/supabase-rpc.sql`, o ejecuta `node scripts/install-supabase-rpc.mjs config.toml`.
2. Añade **solamente** `teldrive_node_api` a los esquemas expuestos por la Data API. No hace falta exponer `teldrive` ni `teldrive_node`.
3. Guarda estas variables en el servidor, fuera de la raíz pública:

```dotenv
DATABASE_TRANSPORT=supabase
SUPABASE_URL=https://TU_PROYECTO.supabase.co
SUPABASE_SECRET_KEY=CLAVE_PRIVADA_DE_SERVIDOR
```

El TOML original puede permanecer intacto. Las variables anteriores cambian únicamente el transporte de Node. También se aceptan `database-transport`, `supabase-url` y `supabase-key` dentro de `[node]`. Una clave secreta o la clave heredada `service_role` sirve para el servidor; una clave publicable/anon no tiene permiso para ejecutar esta RPC.

La función tiene una lista cerrada de operaciones y tablas, `search_path` vacío y permiso de ejecución exclusivamente para `service_role`. No ejecuta SQL suministrado por el visitante. Sus cambios de catálogo y metadatos se confirman en una transacción, y rechaza versiones de archivos que ya hayan cambiado. La tabla de metadatos tiene RLS y no se expone al navegador.

La RPC requiere el esquema v2 posterior a retirar `normalized_name`. No cambia las migraciones Go, tablas originales, sesiones o enlaces de Go. La nueva metadata se guarda en `teldrive_node.records`. Las limitaciones funcionales e interoperabilidad pendientes están en [MIGRATION.md](MIGRATION.md).

Este primer adaptador sigue consultando el catálogo en memoria; HTTPS añade latencia a cada llamada. Conserva las garantías de la transacción de escritura, pero no mantiene una instantánea PostgreSQL durante las lecturas previas. Las restricciones SQL y la comprobación de generaciones protegen los cambios concurrentes de archivos. Para grandes catálogos se recomienda portar filtros y paginación a RPC específicas.

Referencias: [Data API](https://supabase.com/docs/guides/api), [esquemas personalizados](https://supabase.com/docs/guides/api/using-custom-schemas), [claves de servidor](https://supabase.com/docs/guides/api/api-keys).
