# Usuarios con permisos por entrada — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que cada operador vea y gestione solo las entradas que ha creado o que el admin le ha asignado (con sus salidas, grabaciones, telemetría y encoders), y que el admin lo siga viendo todo.

**Architecture:** La lógica de visibilidad vive en un módulo puro (`accessCore.js`, testeable sin base de datos) y un módulo de cableado (`access.js`) que la carga desde SQLite, la mantiene en caché y ofrece middlewares y un `broadcast` filtrado para socket.io. Las rutas existentes de `server.js`, `encoders.js` y `auth.js` llaman a esos helpers. Las grabaciones pasan a una carpeta por entrada (`recordings.js`, puro). Las URLs de operadores se validan con `urlGuard.js` (puro).

**Tech Stack:** Node 22 (CommonJS), Express 5, socket.io 4, sqlite3, `node:test` + `node:assert/strict` (sin dependencias nuevas), JS vanilla en `public/js/app.js`.

**Spec:** `docs/superpowers/specs/2026-11-13-usuarios-permisos-design.md`

## Global Constraints

- Roles: `ROLE_ADMIN = 4`, `ROLE_USER = 16` (operador), exportados por `auth.js`. No se añaden roles.
- Recurso ajeno o inexistente → **404** `{ error: 'Not found' }`, nunca 403 (no revelar que existe).
- Toda comprobación en el servidor; el frontend solo oculta.
- Las entradas existentes y las que no tengan propietario pasan al usuario `admin`; si no existe, al primer administrador por orden alfabético. No se crean asignaciones en la migración.
- Carpeta de grabación: `entrada_<channel>` (minúsculas, sin ceros a la izquierda).
- Mensajes de error y textos de UI en español, mismo tono que los existentes.
- Sin dependencias npm nuevas. Tests con `node --test test/`.
- Commits en español, en la rama actual, terminando con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Operador pide un recurso por id adivinado** (`/api/inputs/7/toggle`, `/api/outputs/12`, `/hls/7/index.m3u8`, `/thumbs/thumb_7.jpg`, `/api/audio/7`, proxy de un encoder ajeno): debe recibir 404 o la página de error del proxy, y no ver nada. → tests de `canSee`/`canSeeOutput` en Task 1 y comprobación manual en Task 9.
2. **Telemetría por socket**: un operador conectado no debe recibir `stats`, `audio_levels`, `telemetry_snapshot`, `rtmp_viewers` ni `encoders_status` de canales que no ve, incluidas las claves `out_<id>`. → test `filterFor` en Task 1.
3. **Cambio de asignaciones con el operador conectado**: al quitarle una entrada deja de recibir su telemetría en el siguiente evento, sin reconectar (el filtro se evalúa en cada emisión contra la caché recargada). → test `canSee after reset` en Task 1.
4. **Grabación con nombre engañoso**: un operador que pone a su salida `disk://` el mismo nombre que la de otro no ve las grabaciones del otro, porque van a `entrada_<n>` distintas; `CAM1` no deja pasar `entrada_10`. → tests en Task 3.
5. **Operador usa una URL local** para leer la señal de otro (`rtmp://127.0.0.1:1935/out/clave_ajena`, `srt://127.0.0.1:9000`, `udp://127.0.0.1:5000`): rechazado con 400; las formas de escucha (`srt://:9000?mode=listener`, `udp://0.0.0.0:5000`, `udp://@:5000`) y RTMP local propio (`/live/<clave libre>`, `/out/<clave libre>`) siguen permitidas. → tests en Task 2.

---

### Task 1: Núcleo de visibilidad (`accessCore.js`) y arnés de tests

**Files:**
- Create: `accessCore.js`
- Create: `test/accessCore.test.js`
- Modify: `package.json` (script `test`)

**Interfaces:**
- Produces:
  - `class AccessState` con:
    - `reset({ inputs, outputs, grants, encoders })` — `inputs: [{channel, owner}]`, `outputs: [{id, channel}]`, `grants: [{username, channel}]`, `encoders: [{id, channel}]` (channel puede ser `null`). Internamente todo con claves `String`.
    - `canSee(user, channel) -> boolean` — `user = { username, role }`. Admin (`role === 4`) siempre `true`. Operador: `owner === username` o asignada. Canal inexistente → `false` para operador, `true` para admin.
    - `canSeeOutput(user, outputId) -> boolean` — por el canal de la salida; salida inexistente → `false` salvo admin.
    - `canSeeEncoder(user, encoderId) -> boolean` — encoder sin canal → solo admin.
    - `visibleChannels(user) -> Set<string> | null` — `null` para admin (= todos).
    - `ownedBy(username) -> string[]`, `grantsOf(username) -> string[]`.
    - `filterFor(user, event, data) -> any | undefined` — devuelve los datos filtrados o `undefined` si no hay que enviar nada. Reglas: `stats` (`data.channel` es canal o `out_<id>`), `audio_levels` y `telemetry_snapshot` (objeto con claves canal o `out_<id>`), `rtmp_viewers` (objeto con claves id de salida), `encoders_status` (array de `{id}`); cualquier otro evento pasa tal cual. Admin recibe siempre `data` sin tocar.
  - `module.exports = { AccessState, ROLE_ADMIN: 4 }`

- [ ] **Step 1: Añadir script de tests**

`package.json`: `"test": "node --test test/"`.

- [ ] **Step 2: Escribir los tests que fallan** (`test/accessCore.test.js`)

Datos de partida para todos los tests:
```js
const st = new AccessState();
st.reset({
  inputs: [{ channel: 1, owner: 'ana' }, { channel: 2, owner: 'admin' }, { channel: 10, owner: 'admin' }],
  outputs: [{ id: 5, channel: 1 }, { id: 6, channel: 2 }],
  grants: [{ username: 'ana', channel: 10 }],
  encoders: [{ id: 1, channel: 2 }, { id: 2, channel: 10 }, { id: 3, channel: null }]
});
const ana = { username: 'ana', role: 16 }, admin = { username: 'admin', role: 4 }, bob = { username: 'bob', role: 16 };
```
Tests y aserciones:
- `canSee propias y asignadas`: `canSee(ana,1)` y `canSee(ana,'10')` true; `canSee(ana,2)` false; `canSee(bob,1)` false; `canSee(admin,2)` true; `canSee(ana,99)` false.
- `canSeeOutput`: `(ana,5)` true, `(ana,6)` false, `(ana,999)` false, `(admin,6)` true.
- `canSeeEncoder`: `(ana,2)` true, `(ana,1)` false, `(ana,3)` false, `(admin,3)` true.
- `visibleChannels`: `ana` → `new Set(['1','10'])`; `admin` → `null`.
- `canSee after reset`: tras `reset` sin la fila de grant, `canSee(ana,10)` false.
- `filterFor stats`: `{channel:'1'}` pasa; `{channel:'2'}` → `undefined`; `{channel:'out_5'}` pasa; `{channel:'out_6'}` → `undefined`.
- `filterFor audio_levels`: `{1:[-3,-3], 2:null, 10:[-6,-6]}` → `{1:[-3,-3], 10:[-6,-6]}`; si queda vacío → `undefined`.
- `filterFor telemetry_snapshot`: `{ '1':[], '2':[], 'out_5':[], 'out_6':[] }` → `{ '1':[], 'out_5':[] }` (vacío → `{}`, que sí se envía).
- `filterFor rtmp_viewers`: `{5:{count:1}, 6:{count:2}}` → `{5:{count:1}}` (vacío → `{}`).
- `filterFor encoders_status`: `[{id:1},{id:2},{id:3}]` → `[{id:2}]`.
- `filterFor admin y otros eventos`: admin recibe el mismo objeto; `sys_stats` y `db_update` pasan intactos para `ana`.

- [ ] **Step 3: Ejecutar y ver que falla**

Run: `npm test`
Expected: FAIL, `Cannot find module '../accessCore'`.

- [ ] **Step 4: Implementar `accessCore.js`**

Mapas `owners: Map<string,string>`, `grants: Map<string, Set<string>>`, `outputs: Map<string,string>` (id→canal), `encoders: Map<string, string|null>`.

- [ ] **Step 5: Ejecutar y ver que pasa**

Run: `npm test` → Expected: todos PASS.

- [ ] **Step 6: Commit** — `Permisos: núcleo de visibilidad por entrada`

---

### Task 2: Validación de URLs de operadores (`urlGuard.js`)

**Files:**
- Create: `urlGuard.js`
- Create: `test/urlGuard.test.js`

**Interfaces:**
- Consumes: nada (puro).
- Produces: `checkOperatorUrl(url, { isInput, items, canSeeChannel, localHosts }) -> string | null`
  - `items: [{ kind: 'input'|'output', channel, url }]` — todas las entradas y salidas actuales (para las claves RTMP).
  - `canSeeChannel(channel) -> boolean`.
  - `localHosts: Set<string>` — `127.0.0.1`, `localhost`, `::1`, `0.0.0.0` y las IPv4/IPv6 propias del servidor. Cualquier `127.x.x.x` también cuenta como local.
  - Devuelve `null` si se permite, o el texto del error.
- Produces: `serverLocalHosts() -> Set<string>` (lee `os.networkInterfaces()` y añade los fijos).

Reglas (solo se aplican a operadores; el admin no pasa por aquí):
1. `disk://...` → permitido.
2. RTMP con host local: solo `/live/<clave>` en entradas y `/out/<clave>` en salidas, y solo si ningún item de un canal **no visible** usa esa misma ruta `/live/<clave>` o `/out/<clave>`. Cualquier otra ruta local → error.
3. SRT con `mode=listener` (o host vacío, `srt://:9000`) → permitido.
4. UDP de entrada con host `0.0.0.0`, `@` o vacío → permitido (escucha).
5. Cualquier otra URL (SRT caller/rendezvous, UDP, RTSP, HTTP…) cuyo host esté en `localHosts` o sea `127.x` → error `'No puedes usar direcciones de este servidor como origen o destino'`.
6. Hosts remotos → permitido.

Texto de error en la regla 2: `'Esa clave RTMP ya la usa otra señal'`.

- [ ] **Step 1: Escribir los tests que fallan** — con `localHosts = new Set(['127.0.0.1','localhost','::1','0.0.0.0','192.168.0.50'])`, `items = [{kind:'input',channel:2,url:'rtmp://127.0.0.1:1935/live/ajena'},{kind:'output',channel:2,url:'rtmp://127.0.0.1:1935/out/ajena'},{kind:'output',channel:1,url:'rtmp://127.0.0.1:1935/out/mia'}]`, `canSeeChannel = c => String(c) === '1'`:
  - null (permitido): `disk:///media/usb/CAM1.mp4`; entrada `srt://:9000?mode=listener`; entrada `srt://0.0.0.0:9000?mode=listener`; entrada `udp://0.0.0.0:5000`; entrada `udp://@:5000`; entrada `rtmp://127.0.0.1:1935/live/nueva`; salida `rtmp://127.0.0.1:1935/out/mia`; salida `srt://remoto.example.com:9000`; entrada `srt://203.0.113.5:9000?mode=caller`.
  - error: entrada `rtmp://127.0.0.1:1935/out/ajena`; entrada `rtmp://127.0.0.1:1935/live/ajena`; salida `rtmp://127.0.0.1:1935/out/ajena`; entrada `srt://127.0.0.1:9000`; entrada `srt://127.5.5.5:9000?mode=caller`; salida `udp://127.0.0.1:5000`; entrada `srt://192.168.0.50:9000?mode=caller`; entrada `srt://localhost:9000`; salida `udp://[::1]:5000`.
- [ ] **Step 2: Ejecutar** `npm test` → FAIL (módulo no existe).
- [ ] **Step 3: Implementar `urlGuard.js`** — parsear con `new URL()` sustituyendo el esquema si hace falta; `@` y host vacío en UDP se detectan sobre el texto antes de parsear.
- [ ] **Step 4: Ejecutar** `npm test` → PASS.
- [ ] **Step 5: Commit** — `Permisos: los operadores no pueden usar URLs locales ajenas`

---

### Task 3: Grabaciones en carpeta por entrada (`recordings.js`)

**Files:**
- Create: `recordings.js`
- Create: `test/recordings.test.js`
- Modify: `streamManager.js:646-665` (`diskTarget`) y su llamada en `:726`

**Interfaces:**
- Produces:
  - `recordingTarget(url, channel, now = new Date()) -> { destUrl, format, dir }` — misma lógica de fecha y extensión que el `diskTarget` actual, pero `destUrl = <dirname(ruta elegida)>/entrada_<channel>/<base>_<fecha><ext>`; `dir` es esa carpeta.
  - `channelOfRecording(filePath) -> string | null` — canal si la carpeta padre inmediata es `entrada_<n>`, si no `null`.
  - `RECORDING_DIR = /^entrada_(\d+)$/`.
- `streamManager.diskTarget(url)` se sustituye por `recordingTarget(url, st.channel)` y se hace `fs.mkdirSync(dir, { recursive: true })` antes de lanzar FFmpeg (después de la comprobación `unmountedDisk` existente, que sigue usando `destUrl`).

- [ ] **Step 1: Tests que fallan** (fecha fija `new Date(2026, 10, 13, 9, 5, 7)`, usar `path.join` para comparar y que pase en Windows y Linux):
  - `disk:///media/usb/CAM1.mp4`, canal 3 → `destUrl` = `/media/usb/entrada_3/CAM1_20261113_090507.mp4`, `format` `mp4`, `dir` `/media/usb/entrada_3`.
  - `disk:///media/usb/CAM1` (sin extensión) → `.../entrada_3/CAM1_20261113_090507.mp4`.
  - `disk:///media/usb/sub/CAM1.ts`, canal 12 → `/media/usb/sub/entrada_12/CAM1_20261113_090507.ts`, `format` `mpegts`; `.mkv` → `matroska`.
  - `channelOfRecording('/media/usb/entrada_3/CAM1_x.mp4')` → `'3'`; `'/media/usb/CAM1_x.mp4'` → `null`; `'/media/usb/entrada_10/CAM1.mp4'` → `'10'`; `'/media/usb/entrada_3x/a.mp4'` → `null`.
- [ ] **Step 2: Ejecutar** `npm test` → FAIL.
- [ ] **Step 3: Implementar `recordings.js`** y conectar en `streamManager.js`.
- [ ] **Step 4: Ejecutar** `npm test` → PASS; `node -e "require('./recordings')"` sin errores.
- [ ] **Step 5: Commit** — `Grabaciones: una carpeta por entrada`

---

### Task 4: Base de datos y módulo `access.js`

**Files:**
- Modify: `db.js` (después del `INSERT` del usuario `admin`, dentro del `serialize`)
- Create: `access.js`

**Interfaces:**
- Consumes: `AccessState` (Task 1), `db`, `ROLE_ADMIN` de `auth.js`.
- Produces (`access.js`):
  - `init() -> Promise<void>` y `reload() -> Promise<void>` — leen `inputs(channel, owner)`, `outputs(id, channel)`, `input_access`, `encoders(id, channel)` y llaman a `state.reset`.
  - `canSee(user, channel)`, `canSeeOutput(user, id)`, `canSeeEncoder(user, id)`, `visibleChannels(user)`, `filterFor(user, event, data)` — delegan en el estado.
  - `requireChannel(param = 'channel')` y `requireOutput(param = 'id')` — middlewares Express; si no puede → `res.status(404).json({ error: 'Not found' })`.
  - `broadcast(event, data)` — recorre `io.sockets.sockets`, aplica `filterFor(socket.data.user, ...)` y emite si no es `undefined`. `setIo(io)` lo configura.
  - `setOwner(channel, username)`, `setGrants(username, channels: number[])` (sustituye todas las asignaciones), `dropUser(username, heir)` (borra grants y pasa sus entradas a `heir`), `forgetChannel(channel)` (borra grants del canal). Todas escriben en SQLite y luego `reload()`.
  - `ownedBy(username)`, `grantsOf(username)`.

DB (`db.js`):
- `ALTER TABLE inputs ADD COLUMN owner TEXT NOT NULL DEFAULT ''` (con callback vacío, como las demás migraciones).
- `CREATE TABLE IF NOT EXISTS input_access (username TEXT NOT NULL, channel INTEGER NOT NULL, PRIMARY KEY (username, channel))`.
- `UPDATE inputs SET owner = (SELECT username FROM users WHERE role = 4 ORDER BY (username = 'admin') DESC, username LIMIT 1) WHERE owner = ''`.

- [ ] **Step 1: Aplicar los cambios de `db.js`.**
- [ ] **Step 2: Implementar `access.js`.**
- [ ] **Step 3: Verificar la migración sobre una copia de la base local**

Primero copia de seguridad: `Copy-Item onpremise.db onpremise.db.bak` (la ruta de la BD la fija `db.js`).
Run: `node -e "const db=require('./db');db.ready.then(()=>require('./access').init()).then(()=>db.all('SELECT channel, owner FROM inputs',(e,r)=>{console.log(r);process.exit(0)}))"`
Expected: todas las filas con `owner` = `admin`; ejecutarlo dos veces no cambia nada; `npm test` sigue en PASS.

- [ ] **Step 4: Commit** — `Permisos: propietario por entrada y tabla de asignaciones`

---

### Task 5: Proteger las rutas de entradas, salidas, previsualización y grabaciones (`server.js`)

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `access.*` (Task 4), `checkOperatorUrl`, `serverLocalHosts` (Task 2), `channelOfRecording` (Task 3), `ROLE_ADMIN`.

Cambios:
- Arranque: `access.setIo(io)` y `access.init()` (después de `auth.init()`), y `streamManager`/`encoders` usan `access.broadcast` (Task 6).
- `GET /api/inputs` y `GET /api/outputs`: filtrar por `visibleChannels(req.user)` (null → todo).
- `POST /api/inputs`: `owner = req.user.username` en el `INSERT`; después `await access.reload()` antes de responder.
- `requireChannel()` en: `POST /api/inputs/:channel/toggle|preview|snapshot|delay`, `PUT/DELETE /api/inputs/:channel`, `GET /api/audio/:channel`, `GET /hls/:channel/index.m3u8`, `GET /hls/:channel/:segment`.
- `/thumbs`: antes del `express.static`, un middleware que extrae `thumb_(\d+)\.jpg` de `req.path` y aplica `canSee`; si no casa el patrón o no puede → 404.
- `DELETE /api/inputs/:channel`: además `access.forgetChannel(channel)` y `reload()`.
- `POST /api/outputs`: si `!canSee(req.user, channel)` → 404.
- `requireOutput()` en `POST /api/outputs/:id/toggle`, `PUT/DELETE /api/outputs/:id`. Tras crear/borrar salidas → `access.reload()`.
- URLs: middleware `operatorUrlGuard(isInput)` añadido junto a `validateSrtBody` en `POST/PUT /api/inputs` y `POST/PUT /api/outputs`; para operadores, si `req.body.url` existe y `checkOperatorUrl` devuelve texto → 400 `{ error }`. `items` se lee de la BD (entradas y salidas con canal y url).
- Puertos: `portCheck.usersOf`/`check`/`describe` reciben un parámetro opcional `canSeeChannel`; la consulta de salidas incluye `o.channel`. Si el elemento no es visible, la etiqueta pasa a ser `'otra señal del servidor'`. `/api/port-check` y `portGuard` pasan `c => access.canSee(req.user, c)`.
- `GET /api/history`: `auth.requireAdmin`.
- Grabaciones:
  - Helper `canSeeRecording(user, absPath) -> boolean`: admin → `isAllowedMediaPath`; operador → `isAllowedMediaPath` **y** `channelOfRecording` no nulo **y** `canSee`.
  - `GET /api/files`: 403 `{ error: 'Acceso denegado a esa ruta' }` si `!isAllowedMediaPath(disk)`. Además de los archivos de la carpeta, recorre sus subcarpetas `entrada_<n>` (un nivel) y añade sus archivos. Para operadores, solo devuelve los que pasen `canSeeRecording`. Mismo formato de respuesta que ahora.
  - `GET /api/media/play`: usar `canSeeRecording`; si no → 404.
  - `app.use('/media', ...)`: solo admin (`auth.requireAdmin` delante del `express.static`).

- [ ] **Step 1: Implementar los cambios.**
- [ ] **Step 2: `node --check server.js` y `npm test`** → sin errores, PASS.
- [ ] **Step 3: Commit** — `Permisos: entradas, salidas, previsualización y grabaciones por usuario`

---

### Task 6: Telemetría filtrada por socket

**Files:**
- Modify: `streamManager.js:144-146` (`emit`)
- Modify: `encoders.js:399` y su `notify`
- Modify: `server.js:640-646` (`io.on('connection')`)

**Interfaces:**
- Consumes: `access.broadcast(event, data)`, `access.filterFor(user, event, data)`.

Cambios:
- `streamManager.emit(event, data)` → `require('./access').broadcast(event, data)` (require perezoso para no crear ciclos al cargar).
- `encoders.js`: `io.emit('encoders_status', statusList())` → `access.broadcast('encoders_status', statusList())`. `db_update` se queda con `io.emit`.
- Conexión nueva: cada `socket.emit` inicial pasa por `access.filterFor(socket.data.user, event, data)` y se omite si da `undefined`.
- `sys_stats` y `db_update` no cambian.

- [ ] **Step 1: Implementar.**
- [ ] **Step 2: `node --check` de los tres archivos y `npm test`** → PASS.
- [ ] **Step 3: Commit** — `Permisos: cada usuario recibe solo la telemetría de sus entradas`

---

### Task 7: Encoders por entrada visible

**Files:**
- Modify: `encoders.js` (`registerRoutes`, `handleRequest`, `handleUpgrade`, `reload`)

**Interfaces:**
- Consumes: `access.canSeeEncoder`, `access.reload`, `ROLE_ADMIN`.

Cambios:
- `GET /api/encoders`: operador → solo los de `canSeeEncoder`, y sin los campos `host`, `web_port`, `vpn_ip`, `vpn_lan` y `vpn_pubkey`. Admin igual que ahora.
- `GET /api/encoders/vpn`: `auth.requireAdmin`.
- Proxy (`handleRequest`): si hay sesión pero `!canSeeEncoder(user, id)` → `page(res, 404, 'Encoder no encontrado', 'Este encoder no está asignado a tu usuario.')`. `handleUpgrade`: `socket.destroy()` en el mismo caso.
- Tras crear, editar o borrar un encoder → `access.reload()` (su canal puede cambiar).

- [ ] **Step 1: Implementar.**
- [ ] **Step 2: `node --check encoders.js`, `npm test`** → PASS.
- [ ] **Step 3: Commit** — `Permisos: el operador ve los encoders de sus entradas`

---

### Task 8: Gestión de asignaciones (API de usuarios + panel)

**Files:**
- Modify: `auth.js` (rutas de usuarios)
- Modify: `server.js` (ruta de propietario)
- Modify: `public/js/app.js` (líneas ~84-95, ~221, ~789, gestor de usuarios ~1812-1945, tarjeta de entrada)
- Modify: `public/index.html` (contenedor de la lista de asignaciones en el modal de usuario)

**Interfaces:**
- Consumes: `access.ownedBy`, `access.grantsOf`, `access.setGrants`, `access.setOwner`, `access.dropUser`.
- Produces (HTTP, solo admin):
  - `GET /api/users/:username/access` → `{ owned: number[], assigned: number[] }`.
  - `PUT /api/users/:username/access` body `{ channels: number[] }` → `{ assigned: number[] }`. Ignora canales inexistentes y los que el usuario ya posee.
  - `PUT /api/inputs/:channel/owner` body `{ owner }` → `{ owner }`; 400 `'Usuario no encontrado'` si no existe.
  - `DELETE /api/users/:username`: antes de borrar, `access.dropUser(username, req.user.username)`.
  - Tras cada cambio: `io.emit('db_update', { event: 'inputs_changed' })` para que los paneles recarguen.

Panel:
- Botón «Añadir entrada» visible para todos los usuarios (quitar las dos condiciones de admin).
- Operador: ocultar el enlace a Grafana y la sección de historial.
- Modal de usuario (solo al editar un operador): lista de entradas con casilla; las propias marcadas y deshabilitadas con la etiqueta «propia»; al guardar, `PUT /api/users/:username/access`.
- Tarjeta de encoder (~2439): si no llega `host`, no pintar la línea `host:puerto` (el operador ve modelo y estado).
- Admin: en cada tarjeta de entrada, el propietario («de ana») y un selector para cambiarlo que llama a `PUT /api/inputs/:channel/owner`.

- [ ] **Step 1: Implementar las rutas.**
- [ ] **Step 2: Implementar el panel.**
- [ ] **Step 3: `node --check auth.js server.js`, `npm test`** → PASS.
- [ ] **Step 4: Commit** — `Usuarios: el admin asigna entradas a los operadores`

---

### Task 9: Verificación de punta a punta

**Files:** ninguno (solo si hay que corregir algo).

- [ ] **Step 1:** Copia de seguridad de `onpremise.db`. Arrancar el panel con `preview_start {name: "panel-srt"}` (puerto 4010).
- [ ] **Step 2:** Como admin: crear el operador `prueba-op` (contraseña de prueba, guardarla en `scratchpad`, no en el chat), crear dos entradas A y B, asignar A a `prueba-op`.
- [ ] **Step 3:** Como `prueba-op` (otra pestaña/ventana privada):
  - La lista muestra solo A; crear C → aparece con propietario `prueba-op`.
  - `fetch('/api/inputs/<B>/toggle',{method:'POST'})` → 404; `/hls/<B>/index.m3u8` → 404; `/thumbs/thumb_<B>.jpg` → 404; `/api/history` → 403; `/media/` → 403.
  - Crear entrada `rtmp://127.0.0.1:1935/out/<clave de una salida de B>` → 400.
  - Con `socket.on('stats', d => ...)` en consola, no llega ningún `channel` de B.
- [ ] **Step 4:** Como admin, quitar A a `prueba-op` → su panel deja de mostrarla tras `db_update` y deja de recibir su telemetría.
- [ ] **Step 5:** Borrar `prueba-op` → C pasa al admin. Borrar las entradas de prueba y restaurar la copia de la BD si hace falta.
- [ ] **Step 6:** Captura de pantalla del panel del operador como prueba. Commit de cualquier corrección.
