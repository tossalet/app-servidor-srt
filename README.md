# app-servidor-srt

Servidor para recibir y entregar señales SRT, UDP y RTMP, con panel web. Pensado para un mini PC HP Intel i7 con Debian 12 / Ubuntu 22.04+.

## Instalación

```bash
sudo bash instalar_servidor.sh
```

Instala Node.js 22, FFmpeg y los drivers de Intel Quick Sync. También ajusta el sistema para vídeo en directo: buffers UDP grandes, CPU en modo `performance`, suspensión desactivada y prioridad alta para el servicio. Si reinstalas, se conservan la base de datos y las variables que añadiste al `.env`.

Opcionalmente instala la **monitorización** (Prometheus + Grafana, ver más abajo).

Con Docker: `docker compose up -d --build`. Con monitorización: `GRAFANA_ADMIN_PASSWORD=... GRAFANA_PORT=3001 docker compose --profile monitoring up -d --build`. Los `sysctl` de buffers UDP se aplican en el host (ver el instalador).

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
- El panel va por HTTP en la red local. Para acceder desde Internet, ponlo detrás de un proxy HTTPS o de una VPN.

## Monitorización: historial, gráficas y alertas

Durante la instalación, el instalador pregunta si quieres monitorización. Si dices que sí, deja en el mini PC:

- **Prometheus:** guarda el historial de `/metrics` (cada 5 s, durante 30 días). Sólo escucha en local.
- **Grafana:** en `http://IP_DEL_MINIPC:3001`, usuario `admin` y la contraseña que elijas. En el panel TSST aparece el enlace **Gráficas**.
- **Dashboard "TSST · Señales en directo"**, precargado:
  - Señales con y sin señal, salidas emitiendo, drops de la última hora, CPU y memoria.
  - Bitrate de entrada y de salida.
  - RTT, % de retransmisión y drops por minuto de SRT.
  - Tabla de estado por señal: OK, bitrate, RTT, latencia, drops, retardo de sincronía.
  - Reinicios por hora, red del mini PC y salud del servidor.
- **Alertas** (carpeta TSST en Grafana → Alerting):

  | Alerta | Cuándo salta |
  |---|---|
  | Señal perdida | Un input activo lleva 30 s sin datos |
  | Salida sin emitir | La entrada tiene señal pero la salida no envía en 1 min |
  | Cortes SRT (drops) | Ha habido drops en los últimos 2 min |
  | Latencia SRT corta para la red | Latencia < 3 × RTT durante 2 min |
  | CPU alta | Más del 90 % durante 2 min |
  | Servidor TSST caído | Prometheus no puede leer el servidor durante 30 s |

- **Avisos por Telegram** (opcional). Crea un bot con [@BotFather](https://t.me/BotFather), añádelo al grupo y pon en el instalador su token y el ID del chat. Para obtener el ID: escribe algo en el grupo y abre `https://api.telegram.org/bot<TOKEN>/getUpdates`.

Prometheus y Grafana corren con prioridad baja (`Nice=10`): el vídeo siempre va primero. Los archivos están en `monitoring/`. Para cambiar Telegram sin reinstalar, edita `/etc/grafana/provisioning/alerting/tsst-telegram.yml` y ejecuta `systemctl restart grafana-server`.

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
| `METRICS_TOKEN` | Token Bearer para leer `/metrics` desde otra máquina |
| `SESSION_HOURS` | Duración de la sesión en horas (por defecto 168 = 7 días) |
