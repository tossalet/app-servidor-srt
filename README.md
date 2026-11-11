# app-servidor-srt

Servidor para recibir y entregar señales SRT, UDP y RTMP, con panel web. Pensado para un mini PC HP Intel i7 con Debian 12 / Ubuntu 22.04+.

## Instalación

```bash
sudo bash instalar_servidor.sh
```

Instala Node.js 22, FFmpeg y los drivers de Intel Quick Sync. También ajusta el sistema para vídeo en directo: buffers UDP grandes, CPU en modo `performance`, suspensión desactivada y prioridad alta para el servicio. Si reinstalas, se conservan la base de datos y las variables que añadiste al `.env`.

Opcionalmente instala la **monitorización** (Prometheus + Grafana, ver más abajo).

Con Docker: `docker compose up -d --build`. Con monitorización: `GRAFANA_ADMIN_PASSWORD=... GRAFANA_PORT=4001 docker compose --profile monitoring up -d --build`. Los `sysctl` de buffers UDP se aplican en el host (ver el instalador).

## Arquitectura

```
fuente SRT/RTMP/UDP ─► FFmpeg input (copy) ─► UDP local ─► DATA PLANE (worker thread) ─┬─► FFmpeg output ─► SRT/RTMP/UDP/disco
                                                                │ retardo de sincronía  ├─► FFmpeg output ...
                                                                └─ sin retardo ─────────► FFmpeg preview (miniatura)
```

- **Data plane** (`dataPlane.js`): reparte los paquetes en un hilo propio. Ni el panel web, ni SQLite, ni un USB lento pueden frenarlo. También mide el bitrate real e instantáneo de cada input.
- Los outputs son independientes del input. Si el input se cae o aún no ha llegado señal, el output espera y arranca solo cuando llegan datos.
- Los puertos UDP internos los asigna el sistema operativo, así que no chocan con los puertos SRT configurados.
- Si un proceso FFmpeg cae, se reinicia con backoff de 1 a 5 s.

## SRT

Sigue la documentación oficial de Haivision ([github.com/Haivision/srt](https://github.com/Haivision/srt)).

- **SRT nativo con `srt-live-transmit`** (paquete `srt-tools`, lo instala el instalador). Las entradas SRT y las salidas SRT en passthrough se hacen con la herramienta de Haivision, no con FFmpeg. La señal pasa tal cual, sin remux, con menos CPU y menos latencia. Además se obtienen las estadísticas reales del enlace. Si no está instalada, se usa FFmpeg automáticamente. Para forzar FFmpeg: `SRT_ENGINE=ffmpeg`.
- **Salud del enlace en el panel:**
  - RTT.
  - Retransmisiones: paquetes reenviados por ARQ.
  - Pérdidas: detectadas, casi siempre recuperadas.
  - Drops: paquetes que no llegaron a tiempo y producen cortes.
  - Latencia efectiva negociada.

  Si la latencia configurada es menor que 3 × RTT, el panel avisa y propone 4 × RTT, como recomienda Haivision. El editor de latencia tiene un botón para aplicarlo.
- **Latencia en milisegundos:** en las URLs del panel `latency` va en ms, la unidad de SRT. FFmpeg la espera en microsegundos, así que se convierte al usarlo. Antes un "120 ms" se enviaba como 0,12 ms.
- **Buffers automáticos:** según `configuration-guidelines.md` de Haivision, si la latencia lo exige se amplían `rcvbuf`/`sndbuf` y la ventana `fc`. Con latencias altas, el buffer por defecto de SRT (8192 paquetes, unos 86 Mbit) descarta paquetes. El cálculo usa `SRT_MAX_MBPS` (por defecto 60). Si pones `rcvbuf` o `fc` en la URL, se respetan.

### Latencia por conexión (entradas y salidas)

Cada entrada y cada **salida** SRT tiene su propia latencia, porque cada una depende de su enlace con el otro extremo. Se configura en el formulario (bloque "Opciones SRT", con preajustes LAN 40 / 120 / Internet 500) o con el lápiz junto a "Latencia SRT" en la tarjeta. Cambiarla reconecta solo esa señal.

- La latencia se negocia al conectar: se usa **la mayor de los dos extremos**. Para la mínima, pon la misma en ambos lados.
- Regla de Haivision y SRS: **3–4 × RTT**. El panel mide el RTT de cada conexión y propone ese valor; en LAN el mínimo propuesto es 40 ms.
- Por debajo de 3 × RTT aparecen drops (cortes), porque no da tiempo a retransmitir.

### Cifrado (passphrase)

AES-128, AES-192 o AES-256 por entrada y por salida, en el mismo bloque "Opciones SRT".

- La passphrase debe tener de **10 a 64 caracteres** y ser **idéntica en los dos extremos**. libsrt admite hasta 80, pero FFmpeg (y los receptores basados en él: OBS, vMix…) solo 64. Caracteres admitidos: letras, números y `. _ ~ ! @ $ * + , ; : -`.
- El servidor rechaza una passphrase no válida al guardar. SRT, en cambio, la rechaza sin avisar y la señal simplemente no llega.
- En el panel la passphrase aparece como `••••••` y en los logs como `passphrase=***`.
- Al editar una entrada o salida se conservan la latencia, la passphrase y cualquier otro parámetro de la URL (`streamid`, etc.). Antes se perdían.

## Sincronizar señales

Cada input tiene un **retardo de sincronía** (0–10 000 ms). Se ajusta en vivo desde el panel (icono de sliders en la ficha del input) y no corta la señal. Se aplica a todas las salidas y grabaciones de ese input. La miniatura no se retrasa.

Procedimiento: toma la señal que llega más tarde como referencia y retrasa las demás hasta que queden alineadas (por ejemplo, con una claqueta o un reloj en pantalla). Los botones ±20/±40 ms equivalen a 1 frame a 50/25 fps.

API: `POST /api/inputs/:channel/delay` con `{ "delay_ms": 240 }`.

## Transcodificación

`Passthrough` (copy) es lo recomendado: casi no usa CPU. Si hace falta convertir, usa **H.264/H.265 por GPU Intel Quick Sync** (VAAPI): decodifica y codifica en la iGPU. Puedes comprobarlo con `vainfo`. Si tu GPU no es `/dev/dri/renderD128`, configura `VAAPI_DEVICE`.

## Acceso y usuarios

El panel, la API, las miniaturas, las grabaciones y la telemetría en vivo piden iniciar sesión.

- **Primer acceso:** usuario `admin`, contraseña `admin`. El panel te obliga a cambiarla antes de entrar. Las instalaciones antiguas cifran sus contraseñas al arrancar. Si alguna es débil (igual al usuario o de menos de 8 caracteres), también obliga a cambiarla.
- **Roles:**
  - **Admin:** todo, incluidos usuarios, puertos y borrar grabaciones.
  - **Operador:** gestiona streams, sincronía y previews.
- **Gestor de usuarios** (Settings, sólo admin): crear, editar rol o email, restablecer contraseñas (con opción de obligar a cambiarlas al entrar) y borrar. Siempre debe quedar al menos un admin, y nadie puede borrar su propia cuenta.
- **Seguridad:**
  - Las contraseñas se guardan con scrypt y sal por usuario.
  - La sesión va en una cookie HttpOnly SameSite=Strict, firmada con `data/session.secret`.
  - Cambiar una contraseña o borrar un usuario cierra sus sesiones al momento.
  - Tras 5 intentos fallidos, la IP queda bloqueada de forma progresiva: 30 s, 60 s… hasta 15 min.
- El panel va por HTTP en la red local, salvo que actives HTTPS (abajo). Para acceder desde Internet, usa HTTPS o una VPN.

## HTTPS (opcional)

El instalador pregunta si quieres HTTPS. Si dices que no, todo sigue por HTTP, que es lo normal en una instalación en red local.

Si dices que sí, pide la ruta del certificado (con su cadena intermedia, `fullchain`) y de su clave privada, en PEM. Por defecto propone `/etc/ssl/produccionvalencia/fullchain.pem` y `privkey.pem`. Antes de seguir comprueba que la clave corresponde al certificado y que no está caducado.

- El panel, la API, el socket y los proxies de los encoders van por HTTPS **en los mismos puertos**. Si hay Grafana, también lleva el certificado.
- Se entra por el nombre del certificado (p. ej. `https://restream.produccionvalencia.es:3000`), que debe apuntar a este equipo. Por IP el navegador avisará de que el certificado no es válido.
- **Renovación:** sustituye los dos ficheros por los nuevos. El panel los recarga solo en menos de un minuto, sin cortar señales, y Grafana se reinicia solo con el nuevo.
- En el log (`journalctl -u tsst-srt`) aparece el certificado en uso y un aviso cuando queden menos de 30 días.
- Si el certificado falta o está mal, el servidor no se cae: avisa en el log y arranca por HTTP.
- Variables: `TLS_CERT_FILE`, `TLS_KEY_FILE` y `TLS_DOMAIN` (sólo para mostrar la dirección) en `/opt/srt-server/.env`. En Docker, ver `docker-compose.yml`.

El instalador también limita los logs del sistema a 500 MB, para que nunca llenen el disco.

## Encoders remotos (URAY y similares)

Sección **Encoders** del panel: encoders H.264/H.265 en otros sitios, manejados en remoto **sin ningún ordenador junto al encoder**. Solo hace falta un router con cliente WireGuard (por ejemplo, un Teltonika RUT241 4G).

```
encoder ──cable──► router 4G del sitio ══ túnel WireGuard ══► mini PC TSST ◄── navegador (panel)
   │                                                            ▲
   └──────────── SRT caller ───────────────────────────────────┘ (entrada SRT listener)
```

- **Vídeo:** el encoder envía SRT en modo **Caller** a `IP_PÚBLICA:puerto` de su entrada (listener) en el panel. Como sale del encoder hacia fuera, no hay que abrir puertos en el sitio.
- **Control:** el router abre un túnel WireGuard hasta el mini PC. El servidor llega así a la web del encoder y la sirve a través de un **proxy autenticado**: botón **Abrir web**, en `http://IP_DEL_SERVIDOR:<panel + 10 + n>`.
  - Solo entra quien tiene sesión en el panel.
  - La cookie del panel nunca se envía al encoder.
  - Las redirecciones y cookies del encoder se adaptan al proxy, y funcionan los WebSocket.
- **Estado cada 10 s:**
  - Si la web del encoder responde, y en cuánto tiempo.
  - Último handshake del túnel del router.
  - Si llega la señal SRT vinculada.

  Va al panel, a `/metrics` (`tsst_encoder_up`, `tsst_encoder_vpn_up`…) y al bot de Telegram, que avisa en cuanto deja de responder.
- **Roles:** cualquier usuario ve el estado y abre la web. Dar de alta, editar, borrar y gestionar la VPN es solo para administradores.

### Poner en marcha un encoder

1. **Servidor:** en el instalador, responde **sí a WireGuard** e indica la IP pública o el DNS del servidor (si tu IP cambia, usa un DNS dinámico). En el router de la sede, abre **UDP 51820** hacia el mini PC. Se crea `/etc/wireguard/wg0.conf` con la red del túnel `10.8.0.0/24`; si reinstalas, se conserva con sus accesos.
2. **Panel → Encoders → Añadir encoder:** nombre, modelo, IP del encoder **en la LAN de su router** (p. ej. `192.168.101.20`), puerto web y la entrada SRT que envía.
3. **VPN → Crear acceso:** indica la LAN del router de ese sitio. **Cada sitio necesita una LAN distinta** (`192.168.101.0/24`, `192.168.102.0/24`…). El servidor le asigna una IP del túnel, genera sus claves y lo aplica sin cortar los demás túneles.
4. **Descargar configuración** e importarla en el router (*VPN → WireGuard*). En el router, permite el tráfico del túnel hacia la LAN (en Teltonika: zona del túnel con *forward* a *lan*).
5. En el encoder: SRT Caller hacia el servidor. En unos segundos la tarjeta muestra el túnel **Activo** y la web **En línea**.

Si prefieres no enrutar la LAN, deja vacía la red del sitio. Entonces, en el router, redirige el puerto web del encoder a su IP del túnel y pon esa IP como IP del encoder.

**Notas:**
- El archivo de configuración contiene la clave privada del router: solo los administradores lo descargan. Si se pierde un router, pulsa **Quitar acceso** y crea uno nuevo.
- Los puertos del proxy van del panel + 10 al panel + 59 (`ENCODER_PROXY_PORT` cambia el primero). El instalador los abre si `ufw` está activo. Si el panel va detrás de un proxy HTTPS, publica también esos puertos o accede por la VPN.
- La gestión de WireGuard desde el panel requiere la instalación nativa: el servicio corre como root. En Docker, el proxy y el estado funcionan, pero el túnel se configura a mano en el host. El estado del túnel requiere `wg` en el contenedor.
- Variables: `WG_ENDPOINT` (dirección pública, la pone el instalador), `WG_INTERFACE` (por defecto `wg0`) y `ENCODER_PROXY_PORT`.

## Monitorización: historial, gráficas y alertas

Durante la instalación, el instalador pregunta si quieres monitorización. Si dices que sí, deja en el mini PC:

- **Prometheus:** guarda el historial de `/metrics` (cada 5 s, durante 30 días). Sólo escucha en local.
- **Historial en el propio dashboard** del panel (sin abrir Grafana): por periodo (15 min, 1 h, 6 h o 24 h), una tabla por señal con % de tiempo con señal, drops SRT, reinicios y RTT máximo, y gráficas de bitrate de entrada y salida, RTT, drops por minuto, CPU y memoria. Se refresca cada 30 s. El servidor consulta a Prometheus con un conjunto fijo de consultas (`history.js`), nunca PromQL enviado desde el navegador. Si Prometheus no está instalado, el dashboard lo indica.
- **Grafana:** en el puerto siguiente al del panel (panel en 2000 → Grafana en `http://IP_DEL_MINIPC:2001`), usuario `admin` y la contraseña que elijas. En el panel TSST aparece el enlace **Gráficas**.
- **Dashboard "TSST · Señales en directo"**, precargado:
  - Señales con y sin señal, salidas emitiendo, drops de la última hora, CPU y memoria.
  - Bitrate de entrada y de salida.
  - RTT, % de retransmisión y drops por minuto de SRT.
  - Tabla de estado por señal: OK, bitrate, RTT, latencia, drops, retardo de sincronía.
  - Reinicios por hora, red del mini PC y salud del servidor.
- **Alerta de Grafana:** solo **Servidor TSST caído**, cuando Prometheus no puede leer el servidor durante 30 s. Es lo único que la app no puede avisar por sí misma. El resto de avisos los manda el bot de Telegram del propio servidor.

### Bot de Telegram

Es opcional y no necesita Grafana. Crea un bot con [@BotFather](https://t.me/BotFather) y añádelo al chat o grupo. Pon su token y el ID del chat en el instalador. Para obtener el ID: escribe algo en el chat y abre `https://api.telegram.org/bot<TOKEN>/getUpdates`. Usa `chat.id`, no `update_id`.

El instalador lo guarda en `/opt/srt-server/.env` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`; admite varios chats separados por comas). En Docker se pasan como variables de entorno. Si cambias el `.env` a mano, reinicia con `systemctl restart tsst-srt`.

**Avisos.** Llegan en unos 5–10 s. Un corte de menos de 3 s no se avisa. Si algo se corta y vuelve una y otra vez, llega un único aviso de "inestable".

| Aviso | Cuándo |
|---|---|
| 🔴 Sin señal / ✅ Señal recuperada (con cuánto duró) | Una entrada deja de recibir datos o vuelve |
| 🔴 La salida no emite / ✅ vuelve a emitir | La entrada tiene señal pero el receptor (vMix, OBS...) se cierra, se desconecta o rechaza la conexión |
| 🟠 Cortes SRT | Paquetes que llegan tarde y se pierden. Incluye la latencia recomendada |
| 🟠 Latencia SRT corta | Latencia menor que 3 × RTT, una vez por conexión |
| ▶️ ⏸️ ➕ ✏️ 🗑️ | Quién enciende, apaga, crea, cambia o borra una entrada o salida en el panel |
| 🔐 ⚠️ | Accesos al panel e intentos fallidos |
| 👁 👋 | Un reproductor (vMix, VLC, OBS...) se conecta a una salida RTMP local o se desconecta, con su IP y cuántos quedan. El panel y `/estado` muestran el número de conexiones, y `/metrics` lo da como `tsst_output_rtmp_viewers`. En una salida RTMP remota (YouTube, Facebook...) no se puede saber: esas conexiones solo las ve la plataforma |
| Encoders | Un encoder remoto deja de responder o vuelve |
| Servidor | CPU o RAM por encima del 90 %, temperatura por encima de 80 °C, arranque y apagado del servidor |

**Comandos** (solo desde los chats configurados):

| Comando | Qué hace |
|---|---|
| `/estado` | Qué entra y qué sale ahora mismo |
| `/informe` | Lo mismo, más RTT, pérdidas, drops, errores y el estado del servidor |
| `/sistema` | CPU, RAM, temperatura, disco, red y tiempo encendido |
| `/historial` | Disponibilidad de cada señal en 24 h (o `/historial 1h`, `/historial 6h`). Necesita Prometheus |
| `/silencio 30` | Pausa los avisos 30 min (sin número, 1 h). `/avisos` los reactiva |

Un mismo bot solo puede atender comandos en un servidor a la vez. Si dos servidores usan el mismo token, los avisos llegan, pero los comandos no.

Prometheus y Grafana corren con prioridad baja (`Nice=10`): el vídeo siempre va primero. Los archivos están en `monitoring/`.

## Métricas (Prometheus / Grafana)

`GET /metrics` en formato Prometheus. Las métricas nunca incluyen URLs, que pueden llevar passphrase o claves de streaming.

**Acceso:**
- Sin `METRICS_TOKEN`: sólo desde la propia máquina, por ejemplo con Prometheus instalado en el mini PC. Lo que llega a través de un proxy local no cuenta como local.
- Con `METRICS_TOKEN=...` (en `/opt/srt-server/.env`): desde cualquier sitio con `Authorization: Bearer <token>`. El token sólo abre `/metrics`, no la API.
- Un administrador con sesión abierta puede verlo en el navegador.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: tsst
    scrape_interval: 5s
    static_configs:
      - targets: ['IP_DEL_MINIPC:3000']
    authorization:
      credentials: 'TU_METRICS_TOKEN'   # quitar si Prometheus corre en el mismo equipo sin token
```

**Métricas principales:**

| Métrica | Qué mide |
|---|---|
| `tsst_input_signal`, `tsst_input_bitrate_bits_per_second` | Si llega señal y con qué bitrate (medido en el data plane) |
| `tsst_input_restarts_total`, `tsst_output_restarts_total` | Caídas y reconexiones |
| `tsst_output_up`, `tsst_output_bitrate_bits_per_second` | Estado de cada salida |
| `tsst_input_sync_delay_seconds` | Retardo de sincronía de cada señal |
| `tsst_srt_rtt_seconds`, `tsst_srt_latency_seconds` | RTT y latencia negociada (`direction="recv"` entradas, `"send"` salidas) |
| `tsst_srt_packets_{lost,retransmitted,dropped}_total` | Calidad del enlace SRT. Los drops son cortes visibles |
| `tsst_host_*`, `tsst_eventloop_lag_p99_seconds` | CPU, memoria y red del mini PC, y salud del servidor |

**Consultas útiles:**
- Pérdida de señal: `tsst_input_signal == 0 and on(channel) tsst_input_up == 1`
- Drops por minuto: `rate(tsst_srt_packets_dropped_total[1m]) * 60`
- % de retransmisión: `rate(tsst_srt_packets_retransmitted_total[1m]) / rate(tsst_srt_packets_total[1m])`
- Latencia corta para la red (consejo de Haivision, < 3 × RTT): `tsst_srt_latency_seconds < 3 * tsst_srt_rtt_seconds`

Las métricas SRT sólo existen cuando la señal va por `srt-live-transmit`.

## Variables de entorno

| Variable | Uso |
|---|---|
| `PORT` | Puerto del panel web (por defecto 4000) |
| `FFMPEG_PATH` | Ruta a un binario FFmpeg concreto |
| `VAAPI_DEVICE` | Dispositivo de la GPU para Quick Sync |
| `SRT_ENGINE` | `ffmpeg` para no usar srt-live-transmit |
| `SRT_LIVE_TRANSMIT_PATH` | Ruta a un binario srt-live-transmit concreto |
| `SRT_MAX_MBPS` | Bitrate máximo previsto por señal SRT para dimensionar buffers (60) |
| `GRAFANA_PORT` | Puerto de Grafana: muestra el enlace "Gráficas" en el panel |
| `PROMETHEUS_URL` | Dónde está Prometheus para el historial del dashboard (por defecto `http://127.0.0.1:9090`) |
| `METRICS_TOKEN` | Token Bearer para leer `/metrics` desde otra máquina |
| `SESSION_HOURS` | Duración de la sesión en horas (por defecto 168 = 7 días) |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | Certificado (fullchain) y clave en PEM: activan HTTPS en el panel y los proxies |
| `GRAFANA_PROTOCOL` | `https` si Grafana lleva el certificado (lo pone el instalador) |
