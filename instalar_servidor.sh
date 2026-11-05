#!/bin/bash
# Instalador del Servidor SRT/RTMP TSST para mini PC x86 (HP Intel i7) con Debian 12 / Ubuntu 22.04+

# Comprobar root
if [ "$EUID" -ne 0 ]; then
  echo "❌ Error: Por favor, ejecuta este instalador con permisos de administrador."
  echo "👉 Usa el comando: sudo bash instalar_servidor.sh"
  exit 1
fi

# Instalar whiptail por si no está (librería para dibujar menús visuales en la consola)
apt-get update -qq
apt-get install -y whiptail

# Bienvenida
whiptail --title "Instalador Servidor SRT TSST" --msgbox "Bienvenido al asistente de instalación del Servidor SRT/RTMP para mini PC Intel.\n\nConfiguraremos el panel, instalaremos Node.js, FFmpeg y los drivers de Intel Quick Sync, y optimizaremos el sistema para vídeo en directo." 14 65

# Preguntar Puerto Web
WEB_PORT=$(whiptail --title "Configuración" --inputbox "Introduce el PUERTO en el que deseas visualizar el Panel de Control Web:\n\n(Ejemplo: 3000, 80, 8080)" 12 60 "3000" 3>&1 1>&2 2>&3)
case "$WEB_PORT" in ''|*[!0-9]*) WEB_PORT=3000 ;; esac

# Preguntar Puerto SRT
SRT_PORT=$(whiptail --title "Configuración" --inputbox "Introduce el PUERTO BASE para la recepción de señal SRT:\n\n(Ejemplo: 8000)" 12 60 "8000" 3>&1 1>&2 2>&3)
if [ -z "$SRT_PORT" ]; then SRT_PORT=8000; fi

# Monitorización opcional: Prometheus (historial) + Grafana (gráficas y alertas)
INSTALL_MONITORING="no"
TELEGRAM="no"
# Grafana va justo al lado del panel: panel 2000 -> Grafana 2001
GRAFANA_PORT=$((WEB_PORT + 1))
if [ "$GRAFANA_PORT" = "$SRT_PORT" ]; then
    whiptail --title "Aviso" --msgbox "El puerto $GRAFANA_PORT (panel + 1, para Grafana) coincide con el puerto base SRT. Grafana usará el $((WEB_PORT + 2))." 10 65
    GRAFANA_PORT=$((WEB_PORT + 2))
fi
if whiptail --title "Monitorización" --yesno "¿Instalar Prometheus y Grafana?\n\nGuardan el historial de las señales (bitrate, RTT, drops...), muestran gráficas y avisan si se cae una cámara.\n\nConsumo aproximado: 200 MB de RAM y CPU casi nula.\nGrafana quedará en el puerto $GRAFANA_PORT." 15 65; then
    INSTALL_MONITORING="yes"
    # En una reinstalación, Grafana ya tiene contraseña: vacío = mantenerla
    GRAFANA_EXISTS="no"
    [ -f /var/lib/grafana/grafana.db ] && GRAFANA_EXISTS="yes"
    while true; do
        if [ "$GRAFANA_EXISTS" = "yes" ]; then
            GRAFANA_PASS=$(whiptail --title "Grafana" --passwordbox "Grafana ya está instalado.\n\nDeja el campo VACÍO para mantener la contraseña actual del usuario 'admin', o escribe una nueva (mínimo 8 caracteres):" 12 65 3>&1 1>&2 2>&3)
            [ -z "$GRAFANA_PASS" ] && break
        else
            GRAFANA_PASS=$(whiptail --title "Grafana" --passwordbox "Contraseña para el usuario 'admin' de Grafana (mínimo 8 caracteres):" 10 60 3>&1 1>&2 2>&3)
        fi
        [ ${#GRAFANA_PASS} -ge 8 ] && break
        whiptail --title "Grafana" --msgbox "La contraseña debe tener al menos 8 caracteres." 8 60
    done

fi

# Bot de Telegram: avisos en segundos y comandos (/estado, /informe...). No necesita Grafana.
# Ya configurado en una instalación anterior (en el .env de la app o en Grafana): se ofrece mantenerlo
OLD_TOKEN=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' /opt/srt-server/.env 2>/dev/null | head -1)
OLD_CHAT=$(sed -n 's/^TELEGRAM_CHAT_ID=//p' /opt/srt-server/.env 2>/dev/null | head -1)
TG_FILE=/etc/grafana/provisioning/alerting/tsst-telegram.yml
if { [ -z "$OLD_TOKEN" ] || [ -z "$OLD_CHAT" ]; } && [ -f "$TG_FILE" ]; then
    OLD_TOKEN=$(sed -n 's/^ *bottoken: *"\(.*\)"/\1/p' "$TG_FILE" | head -1)
    OLD_CHAT=$(sed -n 's/^ *chatid: *"\(.*\)"/\1/p' "$TG_FILE" | head -1)
fi
if [ -n "$OLD_TOKEN" ] && [ -n "$OLD_CHAT" ] && whiptail --title "Telegram" --yesno "Ya tienes el bot de Telegram configurado (chat $OLD_CHAT).\n\n¿Mantener esta configuración?" 11 65; then
    TELEGRAM="yes"; TG_TOKEN="$OLD_TOKEN"; TG_CHAT="$OLD_CHAT"
elif whiptail --title "Telegram" --yesno "¿Quieres un bot de Telegram para el servidor?\n\nAvisa en segundos de todo lo que pasa (señales, salidas, cortes, cambios en el panel) y responde a comandos como /estado o /informe.\n\nNecesitas un bot (créalo hablando con @BotFather) y el ID del chat o grupo." 15 70; then
    TELEGRAM="yes"
    TG_TOKEN=$(whiptail --title "Telegram" --inputbox "Token del bot (ej. 123456:ABC-DEF...):" 10 65 3>&1 1>&2 2>&3)
    TG_CHAT=$(whiptail --title "Telegram" --inputbox "ID del chat o grupo (ej. 6008034948 o -1001234567890):" 10 65 3>&1 1>&2 2>&3)
    if [ -z "$TG_TOKEN" ] || [ -z "$TG_CHAT" ]; then TELEGRAM="no"; fi
fi
# Sólo caracteres válidos: el token y el chat acaban en el .env y en un sed
case "$TG_TOKEN" in *[!A-Za-z0-9:_-]*) TELEGRAM="no" ;; esac
case "$TG_CHAT" in *[!0-9,-]*) TELEGRAM="no" ;; esac

# WireGuard opcional: túnel con los routers 4G de los encoders remotos (sección Encoders del panel)
INSTALL_WG="no"
WG_PORT=51820
WG_EXISTS="no"
[ -f /etc/wireguard/wg0.conf ] && WG_EXISTS="yes"
WG_QUESTION="¿Activar WireGuard para manejar encoders remotos (URAY...)?\n\nEl router 4G de cada encoder abre un túnel hasta este servidor, y desde el panel (sección Encoders) se entra en la web del encoder sin ningún ordenador en el sitio.\n\nNecesitas abrir el puerto UDP $WG_PORT hacia este mini PC en el router de aquí."
[ "$WG_EXISTS" = "yes" ] && WG_QUESTION="WireGuard ya está configurado en este servidor (se conservan los accesos de los routers).\n\n¿Mantenerlo activo?"
if whiptail --title "Encoders remotos" --yesno "$WG_QUESTION" 16 70; then
    INSTALL_WG="yes"
    OLD_ENDPOINT=$(sed -n 's/^WG_ENDPOINT=//p' /opt/srt-server/.env 2>/dev/null | head -1)
    DETECTED_IP=$(curl -s --max-time 5 https://api.ipify.org || true)
    WG_ENDPOINT=$(whiptail --title "WireGuard" --inputbox "IP pública o nombre DNS con el que los routers llegan a este servidor (si tu IP cambia, usa un DNS dinámico):" 11 70 "${OLD_ENDPOINT:-$DETECTED_IP}" 3>&1 1>&2 2>&3)
    # Sólo IP o nombre DNS, con puerto opcional
    case "$WG_ENDPOINT" in *[!A-Za-z0-9.:-]*) WG_ENDPOINT="" ;; esac
fi

MONITORING_TEXT="No"
if [ "$INSTALL_MONITORING" = "yes" ]; then MONITORING_TEXT="Sí (Grafana en puerto $GRAFANA_PORT)"; fi

# Confirmación Final
WG_TEXT="No"
if [ "$INSTALL_WG" = "yes" ]; then WG_TEXT="Sí (UDP $WG_PORT, ${WG_ENDPOINT:-sin dirección pública})"; fi

whiptail --title "Resumen de Instalación" --yesno "Se procederá a instalar con la siguiente configuración:\n\n- Panel Web: Puerto $WEB_PORT\n- Señal SRT: Puerto Base $SRT_PORT\n- Monitorización: $MONITORING_TEXT\n- Bot de Telegram: $TELEGRAM\n- WireGuard (encoders): $WG_TEXT\n\n¿Deseas iniciar la instalación ahora?" 17 70

if [ $? -ne 0 ]; then
    clear
    echo "Instalación cancelada por el usuario."
    exit 1
fi

clear
echo "🛠️ Iniciando instalación de dependencias base..."
# srt-tools trae srt-live-transmit (Haivision): SRT nativo con estadísticas de enlace
apt-get install -y ffmpeg srt-tools curl wget build-essential git vainfo

echo "🎞️ Instalando drivers de Intel Quick Sync (VAAPI)..."
# El driver non-free incluye todos los codificadores; si el repo no está activo usamos el libre
apt-get install -y intel-media-va-driver-non-free || apt-get install -y intel-media-va-driver i965-va-driver

echo "📦 Instalando Node.js..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "⚡ Optimizando el sistema para vídeo en directo..."
# Buffers UDP grandes: sin esto el kernel recorta a ~200 KB los buffers de 8 MB que piden
# SRT, FFmpeg y el data plane, y se pierden paquetes en picos de bitrate
cat <<EOF > /etc/sysctl.d/90-tsst-srt.conf
net.core.rmem_max = 67108864
net.core.wmem_max = 67108864
net.core.rmem_default = 4194304
net.core.wmem_default = 4194304
net.core.netdev_max_backlog = 10000
net.ipv4.udp_rmem_min = 16384
net.ipv4.udp_wmem_min = 16384
EOF
sysctl --system > /dev/null

# CPU siempre a máxima frecuencia: evita latencias al despertar núcleos (jitter en SRT)
cat <<EOF > /etc/systemd/system/tsst-cpu-performance.service
[Unit]
Description=CPU governor performance para TSST
After=multi-user.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'for g in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo performance > \$g 2>/dev/null; done; true'

[Install]
WantedBy=multi-user.target
EOF

# Un servidor no debe suspenderse nunca
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target > /dev/null 2>&1

echo "📂 Configurando el entorno de la aplicación..."
APP_DIR="/opt/srt-server"
BACKUP_DIR=""
# Conservar la base de datos (inputs/outputs configurados) y variables extra (.env) en reinstalaciones
if [ -d "$APP_DIR/data" ] || [ -f "$APP_DIR/.env" ]; then
    BACKUP_DIR=$(mktemp -d)
    [ -d "$APP_DIR/data" ] && cp -a "$APP_DIR/data" "$BACKUP_DIR/"
    [ -f "$APP_DIR/.env" ] && cp -a "$APP_DIR/.env" "$BACKUP_DIR/env.old"
fi
rm -rf $APP_DIR
mkdir -p $APP_DIR

# Descargamos la aplicación a su carpeta definitiva en linux (/opt/) desde GitHub
echo "Copiando archivos..."
# IMPORTANTE: Cambia esta URL por la de tu repositorio de GitHub real.
GITHUB_REPO="https://github.com/tossalet/app-servidor-srt.git"
git clone $GITHUB_REPO $APP_DIR
cd $APP_DIR

if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR/data" ]; then
    cp -a "$BACKUP_DIR/data" "$APP_DIR/"
fi

echo "⚙️ Instalando dependencias de Node (npm install)..."
npm install --omit=dev

# Crear archivo .env para el puerto
echo "PORT=$WEB_PORT" > .env
# Si nuestra app lee SRT_PORT del .env, también lo ponemos (dependiendo de nuestra lógica en app)
echo "SRT_BASE_PORT=$SRT_PORT" >> .env
# El panel muestra el enlace "Gráficas" si hay Grafana
if [ "$INSTALL_MONITORING" = "yes" ]; then echo "GRAFANA_PORT=$GRAFANA_PORT" >> .env; fi
# Dirección pública que se pone en la configuración de los routers de los encoders
ENV_REPLACED='PORT|SRT_BASE_PORT|GRAFANA_PORT|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID'
# Bot de Telegram (telegram.js)
if [ "$TELEGRAM" = "yes" ]; then
    echo "TELEGRAM_BOT_TOKEN=$TG_TOKEN" >> .env
    echo "TELEGRAM_CHAT_ID=$TG_CHAT" >> .env
fi
if [ "$INSTALL_WG" = "yes" ]; then
    ENV_REPLACED="$ENV_REPLACED|WG_ENDPOINT"
    [ -n "$WG_ENDPOINT" ] && echo "WG_ENDPOINT=$WG_ENDPOINT" >> .env
fi
# Variables añadidas a mano en la instalación anterior (METRICS_TOKEN, SRT_MAX_MBPS...)
if [ -n "$BACKUP_DIR" ] && [ -f "$BACKUP_DIR/env.old" ]; then
    grep -vE "^($ENV_REPLACED)=" "$BACKUP_DIR/env.old" >> .env
fi
[ -n "$BACKUP_DIR" ] && rm -rf "$BACKUP_DIR"
chmod 600 .env

if [ "$INSTALL_WG" = "yes" ]; then
    echo "🔐 Configurando WireGuard para los encoders remotos..."
    apt-get install -y wireguard-tools iproute2
    mkdir -p /etc/wireguard
    chmod 700 /etc/wireguard
    # En una reinstalación se conserva wg0.conf: ahí están los accesos de los routers que crea el panel
    if [ ! -f /etc/wireguard/wg0.conf ]; then
        WG_KEY=$(wg genkey)
        cat <<EOF > /etc/wireguard/wg0.conf
# Servidor TSST. Los [Peer] de los routers los añade y quita el panel (sección Encoders).
[Interface]
Address = 10.8.0.1/24
ListenPort = $WG_PORT
PrivateKey = $WG_KEY
EOF
    fi
    chmod 600 /etc/wireguard/wg0.conf
    systemctl enable wg-quick@wg0 > /dev/null 2>&1
    systemctl restart wg-quick@wg0
    # Cortafuegos local, si está activo: túnel y proxies de las webs de los encoders (panel + 10 en adelante)
    if command -v ufw > /dev/null && ufw status | grep -q "Status: active"; then
        ufw allow $WG_PORT/udp > /dev/null
        ufw allow $((WEB_PORT + 10)):$((WEB_PORT + 59))/tcp > /dev/null
    fi
fi

echo "🚀 Creando servicio de arranque automático (Systemd)..."
cat <<EOF > /etc/systemd/system/tsst-srt.service
[Unit]
Description=Servidor SRT TSST y Panel Web
After=network-online.target wg-quick@wg0.service
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node $APP_DIR/server.js
WorkingDirectory=$APP_DIR
Restart=always
RestartSec=2
User=root
Environment=PATH=/usr/bin:/usr/local/bin:/usr/sbin:/sbin
Environment=NODE_ENV=production
EnvironmentFile=$APP_DIR/.env
# Prioridad sobre el resto del sistema (la heredan los procesos FFmpeg)
Nice=-10
IOSchedulingClass=best-effort
IOSchedulingPriority=0
LimitNOFILE=65536
# SIGTERM a Node para cerrar grabaciones limpias; lo que quede se mata a los 10 s
KillMode=mixed
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
EOF

# Refrescar y activar que inicie en cada arranque
systemctl daemon-reload
systemctl enable --now tsst-cpu-performance.service
systemctl enable tsst-srt.service
systemctl restart tsst-srt.service
systemctl status tsst-srt.service --no-pager

if [ "$INSTALL_MONITORING" = "yes" ]; then
    MON="$APP_DIR/monitoring"

    echo "📈 Instalando Prometheus (historial de métricas)..."
    apt-get install -y --no-install-recommends prometheus
    cp "$MON/prometheus.yml" /etc/prometheus/prometheus.yml
    sed -i "s/localhost:4000/localhost:$WEB_PORT/" /etc/prometheus/prometheus.yml
    # Sólo escucha en local (Grafana está en el mismo equipo) y guarda 30 días
    echo 'ARGS="--web.listen-address=127.0.0.1:9090 --storage.tsdb.retention.time=30d"' > /etc/default/prometheus

    echo "📊 Instalando Grafana (gráficas y alertas)..."
    apt-get install -y apt-transport-https gnupg
    mkdir -p /etc/apt/keyrings
    wget -q -O - https://apt.grafana.com/gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/grafana.gpg
    echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" > /etc/apt/sources.list.d/grafana.list
    apt-get update -qq
    apt-get install -y grafana

    # Fuente de datos, dashboard y reglas de alerta precargados
    mkdir -p /etc/grafana/provisioning/datasources /etc/grafana/provisioning/dashboards /etc/grafana/provisioning/alerting /var/lib/grafana/dashboards/tsst
    cp "$MON/grafana/provisioning/datasources/tsst.yml" /etc/grafana/provisioning/datasources/tsst.yml
    cp "$MON/grafana/provisioning/dashboards/tsst.yml" /etc/grafana/provisioning/dashboards/tsst.yml
    cp "$MON/grafana/provisioning/alerting/tsst-rules.yml" /etc/grafana/provisioning/alerting/tsst-rules.yml
    cp "$MON/grafana/dashboards/tsst.json" /var/lib/grafana/dashboards/tsst/tsst.json
    chown -R grafana:grafana /var/lib/grafana/dashboards
    rm -f /etc/grafana/provisioning/alerting/tsst-telegram.yml
    if [ "$TELEGRAM" = "yes" ]; then
        # | como separador: el token del bot lleva ":"
        sed -e "s|__BOT_TOKEN__|$TG_TOKEN|" -e "s|__CHAT_ID__|$TG_CHAT|" "$MON/grafana/telegram.yml.template" > /etc/grafana/provisioning/alerting/tsst-telegram.yml
        chown root:grafana /etc/grafana/provisioning/alerting/tsst-telegram.yml
        chmod 640 /etc/grafana/provisioning/alerting/tsst-telegram.yml
    fi

    # Ajustes de Grafana y prioridad baja para Prometheus/Grafana: el vídeo siempre va primero
    mkdir -p /etc/systemd/system/grafana-server.service.d /etc/systemd/system/prometheus.service.d
    cat <<EOF > /etc/systemd/system/grafana-server.service.d/tsst.conf
[Service]
Nice=10
Environment=GF_SERVER_HTTP_PORT=$GRAFANA_PORT
# Permite puertos por debajo de 1024 (p. ej. panel en 80 -> Grafana en 81)
AmbientCapabilities=CAP_NET_BIND_SERVICE
Environment=GF_USERS_ALLOW_SIGN_UP=false
Environment=GF_AUTH_ANONYMOUS_ENABLED=false
Environment=GF_ANALYTICS_REPORTING_ENABLED=false
Environment=GF_ANALYTICS_CHECK_FOR_UPDATES=false
Environment=GF_NEWS_NEWS_FEED_ENABLED=false
Environment=GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/var/lib/grafana/dashboards/tsst/tsst.json
EOF
    cat <<EOF > /etc/systemd/system/prometheus.service.d/tsst.conf
[Service]
Nice=10
EOF
    systemctl daemon-reload
    systemctl enable prometheus grafana-server
    systemctl restart prometheus grafana-server

    # Contraseña del admin de Grafana (también vale en reinstalaciones). Se espera a que arranque.
    for i in $(seq 1 30); do
        curl -s "http://127.0.0.1:$GRAFANA_PORT/api/health" > /dev/null && break
        sleep 2
    done
    if [ -n "$GRAFANA_PASS" ]; then
        runuser -u grafana -- grafana cli --homepath /usr/share/grafana --config /etc/grafana/grafana.ini admin reset-admin-password "$GRAFANA_PASS" > /dev/null \
            || runuser -u grafana -- grafana-cli --homepath /usr/share/grafana --config /etc/grafana/grafana.ini admin reset-admin-password "$GRAFANA_PASS" > /dev/null
    fi
fi

LOCAL_IP=$(hostname -I | awk '{print $1}')

GRAFANA_TEXT=""
if [ "$INSTALL_MONITORING" = "yes" ]; then GRAFANA_TEXT="\n\n📊 Gráficas y alertas (Grafana, usuario admin):\n👉 http://$LOCAL_IP:$GRAFANA_PORT"; fi

whiptail --title "¡Instalación Completada!" --msgbox "El Servidor SRT se ha instalado correctamente y arrancará solo cada vez que enciendas el mini PC.\n\nPuedes acceder a tu panel de control desde cualquier navegador en la red ingresando a:\n\n👉 http://$LOCAL_IP:$WEB_PORT$GRAFANA_TEXT" 18 65

clear
echo "✅ ¡Instalación Finalizada con éxito!"
echo "📍 Panel Web en: http://$LOCAL_IP:$WEB_PORT"
if [ "$INSTALL_MONITORING" = "yes" ]; then echo "📊 Grafana en: http://$LOCAL_IP:$GRAFANA_PORT (usuario admin)"; fi
if [ "$INSTALL_WG" = "yes" ]; then
    echo "🔐 WireGuard activo en UDP $WG_PORT. Abre ese puerto hacia $LOCAL_IP en el router de aquí."
    echo "   Los accesos de los routers de los encoders se crean en el panel: Encoders → VPN."
fi
echo "🎞️ Comprueba Quick Sync con: vainfo"
