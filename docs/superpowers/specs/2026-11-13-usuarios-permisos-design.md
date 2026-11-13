# Usuarios y permisos por entrada — diseño

Fecha: 2026-11-13

## Intención

Hoy hay dos roles (admin = 4, operador = 16) y cualquier operador ve y gestiona **todas** las entradas y salidas. Queremos que:

- **Admin** lo vea y lo controle todo, como ahora.
- **Operador** vea solo las entradas que ha creado y las que el admin le asigne (aunque sean de otro usuario). Esas las puede gestionar por completo; las demás no existen para él.

No está claro todavía si los operadores serán técnicos del equipo o clientes externos, así que se diseña en modo estricto: **lo que un operador no puede ver no le llega por ninguna vía** (listas, API, socket, vista previa, grabaciones, encoders).

## Objetivos

- Propietario por entrada y asignaciones de entradas a operadores.
- Filtrado y control de acceso en todo lo que cuelga de una entrada: salidas, vista previa HLS, audio, capturas, retardo, telemetría en directo, grabaciones y encoders vinculados.
- Gestión de asignaciones desde el gestor de usuarios del admin.

## No objetivos

- Grupos o clientes (enfoque 2, descartado por ahora; se podría añadir encima más adelante).
- Controlar los encoders por su API desde nuestro panel: es el siguiente proyecto, aparte.
- Permisos más finos que «ve y gestiona» (p. ej. solo lectura).

## Anti-objetivos

- Que un operador pueda ver o actuar sobre una entrada ajena adivinando un `channel`, un id de salida o un puerto del proxy de encoders.
- Que el filtrado dependa del frontend: toda comprobación vive en el servidor.

## Enfoques considerados

1. **Propietario + asignaciones** — `inputs.owner` + tabla de asignaciones usuario↔entrada. Visible = propia o asignada. Sencillo y encaja con «asignar entradas sueltas». **Elegido.**
2. **Grupos/clientes** — usuarios y entradas pertenecen a grupos. Compensa si varios operadores comparten siempre el mismo lote; añade gestionar grupos. Descartado por ahora.

## Decisiones del usuario

- Enfoque 1.
- Las entradas existentes pasan a ser del usuario `admin` (si no existe, del primer administrador).
- Los encoders se asignan a través de su entrada vinculada: un operador ve un encoder si puede ver su `channel`.
- Un operador puede crear entradas y gestionar las que ve.

## Diseño

### Datos (db.js)

- `ALTER TABLE inputs ADD COLUMN owner TEXT NOT NULL DEFAULT ''`; migración: las filas con `owner = ''` pasan al admin.
- `CREATE TABLE input_access (username TEXT NOT NULL, channel INTEGER NOT NULL, PRIMARY KEY (username, channel))`.
- Al borrar una entrada se borran sus filas de `input_access`. Al borrar un usuario se borran sus asignaciones y **sus entradas propias pasan al admin que lo borra** (no se pierden señales en marcha).

### Regla de visibilidad (un único sitio)

Módulo nuevo (p. ej. `access.js`) con caché en memoria como la de usuarios:

- `canSee(user, channel)`: admin → siempre; operador → `owner === user` o asignada.
- `visibleChannels(user)`: conjunto de canales (admin: todos).
- Middleware `requireChannel(param)` que responde 404 (no 403, para no revelar que existe) si no puede verla.
- Para salidas: se resuelve su `channel` y se aplica la misma regla.

### Dónde se aplica

| Recurso | Regla |
|---|---|
| `GET /api/inputs`, `GET /api/outputs` | Filtrados por `visibleChannels` |
| `POST /api/inputs` | `owner = req.user.username` |
| `PUT/DELETE /api/inputs/:channel`, toggle, preview, snapshot, delay | `requireChannel` |
| `POST /api/outputs` | El `channel` de destino debe ser visible |
| `PUT/DELETE/toggle /api/outputs/:id` | La salida debe pertenecer a un canal visible |
| `/hls/:channel/*`, `/api/audio/:channel` | `requireChannel` |
| Telemetría socket (`stats`, `audio_levels`, `telemetry_snapshot`, `rtmp_viewers`) | Rooms por canal: cada socket se une a `ch:<n>` de sus canales visibles; `stats` y `audio_levels` se emiten por room; el snapshot inicial se filtra. Al cambiar asignaciones o propietario se recalculan las rooms de los sockets afectados |
| `db_update` | Puede seguir siendo global (solo avisa de recargar; la recarga ya llega filtrada) |
| `GET /api/encoders` y estado `encoders_status` | Operador: solo encoders con `channel` visible. Alta/edición/VPN: solo admin (como hoy) |
| Proxy web de encoders (puerto por encoder) | Además de sesión válida, `canSee(user, enc.channel)`; sin canal vinculado → solo admin |
| Grabaciones `GET /api/files`, `/api/media/play`, `/media/*` | Ver «Grabaciones» abajo. Borrar sigue siendo solo admin |
| `/thumbs/thumb_N.jpg` | `requireChannel` |
| `/api/history`, Grafana, `/metrics` | Solo admin |
| `GET /api/disks`, `GET /api/ports` | Lectura abierta a operadores (los necesitan para grabar y para dar de alta entradas). Montar/gestionar discos y editar puertos: solo admin |
| Usuarios | Como hoy (admin) |
| `GET /api/port-check` | Sigue funcionando para operadores pero sin decir qué entrada ocupa el puerto si no es visible |

### Grabaciones (decidido por el usuario)

- El servidor fuerza una **carpeta por entrada**: toda salida `disk://` graba en `<disco>/entrada_<channel>/<nombre>_<fecha>.mp4`, elija el operador la ruta que elija dentro del disco.
- Un usuario ve las carpetas `entrada_<n>` de los canales que puede ver. Las grabaciones antiguas (fuera de esas carpetas) se quedan donde están y solo las ve el admin.
- `/api/files` y `/api/media/play` solo aceptan rutas dentro de los discos conocidos y, para operadores, dentro de una carpeta `entrada_<n>` visible. `/media` estático deja de servir sin filtro (o pasa por el mismo control).

### URLs de entradas y salidas de operadores

- Para operadores, el servidor rechaza URLs que apunten al propio servidor (`127.0.0.0/8`, `::1`, `localhost`, IPs propias del servidor), para que no puedan engancharse a la salida RTMP/SRT/UDP local de una entrada ajena. El admin no tiene esta restricción.

### Migración de operadores existentes (decidido por el usuario)

- Todas las entradas pasan al admin y **no se crean asignaciones**: los operadores actuales verán el panel vacío hasta que el admin les asigne entradas. Avisar de esto en las notas del despliegue.

### Gestor de usuarios (admin)

- En la edición de un operador: lista de entradas con casilla «asignada»; las propias del operador aparecen marcadas y bloqueadas.
- Endpoint `PUT /api/users/:username/access` con la lista de canales asignados.
- En la lista de entradas (vista admin) se muestra el propietario y el admin puede cambiarlo.
- Pasar un usuario a admin no borra sus asignaciones (simplemente dejan de importar).

### Panel (operador)

- Ve menos cosas. Se ocultan las pestañas o secciones que ya no le sirven (historial/Grafana).
- Se le muestra el botón «Añadir entrada» (hoy solo admin, app.js ~221 y ~789).

## Decisiones tomadas por mí (revisables)

- 404 en vez de 403 para recursos ajenos.
- Un operador puede borrar una entrada que le han asignado aunque no sea suya («gestionar las que pueda ver»).
- Las entradas de un usuario borrado pasan al admin que lo borra.
- Telegram sigue igual (canal del admin).
- Bloqueo de URLs locales del servidor para operadores.
- `/api/files` limitado a los discos conocidos.
- Para operadores, `GET /api/encoders` no devuelve host ni datos de VPN.
- La telemetría `out_<id>` y `rtmp_viewers` se filtran también por canal visible.

## A criterio del implementador

- Nombre y forma exacta del módulo de acceso y del endpoint de asignaciones.
- Cómo se marca visualmente el propietario en la UI del admin.
