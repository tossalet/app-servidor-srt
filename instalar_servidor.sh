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
if [ -z "$WEB_PORT" ]; then WEB_PORT=3000; fi

# Preguntar Puerto SRT
SRT_PORT=$(whiptail --title "Configuración" --inputbox "Introduce el PUERTO BASE para la recepción de señal SRT:\n\n(Ejemplo: 8000)" 12 60 "8000" 3>&1 1>&2 2>&3)
if [ -z "$SRT_PORT" ]; then SRT_PORT=8000; fi

# Monitorización opcional: Prometheus (historial) + Grafana (gráficas y alertas)
INSTALL_MONITORING="no"
TELEGRAM="no"
GRAFANA_PORT=3001
if [ "$WEB_PORT" = "$GRAFANA_PORT" ]; then GRAFANA_PORT=3002; fi
if whiptail --title "Monitorización" --yesno "¿Instalar Prometheus y Grafana?\n\nGuardan el historial de las señales (bitrate, RTT, drops...), muestran gráficas y avisan si se cae una cámara.\n\nConsumo aproximado: 200 MB de RAM y CPU casi nula.\nGrafana quedará en el puerto $GRAFANA_PORT." 15 65; then
    INSTALL_MONITORING="yes"
    while true; do
        GRAFANA_PASS=$(whiptail --title "Grafana" --passwordbox "Contraseña para el usuario 'admin' de Grafana (mínimo 8 caracteres):" 10 60 3>&1 1>&2 2>&3)
        [ ${#GRAFANA_PASS} -ge 8 ] && break
        whiptail --title "Grafana" --msgbox "La contraseña debe tener al menos 8 caracteres." 8 60
    done
    if whiptail --title "Alertas" --yesno "¿Quieres recibir las alertas por Telegram?\n\nNecesitas un bot (créalo hablando con @BotFather) y el ID del chat o grupo donde avisará." 12 65; then
        TELEGRAM="yes"
        TG_TOKEN=$(whiptail --title "Telegram" --inputbox "Token del bot (ej. 123456:ABC-DEF...):" 10 65 3>&1 1>&2 2>&3)
        TG_CHAT=$(whiptail --title "Telegram" --inputbox "ID del chat o grupo (ej. -1001234567890):" 10 65 3>&1 1>&2 2>&3)
        if [ -z "$TG_TOKEN" ] || [ -z "$TG_CHAT" ]; then TELEGRAM="no"; fi
    fi
fi

MONITORING_TEXT="No"
if [ "$INSTALL_MONITORING" = "yes" ]; then MONITORING_TEXT="Sí (Grafana en puerto $GRAFANA_PORT, Telegram: $TELEGRAM)"; fi

# Confirmación Final
whiptail --title "Resumen de Instalación" --yesno "Se procederá a instalar con la siguiente configuración:\n\n- Panel Web: Puerto $WEB_PORT\n- Señal SRT: Puerto Base $SRT_PORT\n- Monitorización: $MONITORING_TEXT\n\n¿Deseas iniciar la instalación ahora?" 15 65

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
# Variables añadidas a mano en la instalación anterior (METRICS_TOKEN, SRT_MAX_MBPS...)
if [ -n "$BACKUP_DIR" ] && [ -f "$BACKUP_DIR/env.old" ]; then
    grep -vE '^(PORT|SRT_BASE_PORT|GRAFANA_PORT)=' "$BACKUP_DIR/env.old" >> .env
fi
[ -n "$BACKUP_DIR" ] && rm -rf "$BACKUP_DIR"
chmod 600 .env

echo "🚀 Creando servicio de arranque automático (Systemd)..."
cat <<EOF > /etc/systemd/system/tsst-srt.service
[Unit]
Description=Servidor SRT TSST y Panel Web
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node $APP_DIR/server.js
WorkingDirectory=$APP_DIR
Restart=always
RestartSec=2
User=root
Environment=PATH=/usr/bin:/usr/local/bin
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
    runuser -u grafana -- grafana cli --homepath /usr/share/grafana --config /etc/grafana/grafana.ini admin reset-admin-password "$GRAFANA_PASS" > /dev/null \
        || runuser -u grafana -- grafana-cli --homepath /usr/share/grafana --config /etc/grafana/grafana.ini admin reset-admin-password "$GRAFANA_PASS" > /dev/null
fi

LOCAL_IP=$(hostname -I | awk '{print $1}')

GRAFANA_TEXT=""
if [ "$INSTALL_MONITORING" = "yes" ]; then GRAFANA_TEXT="\n\n📊 Gráficas y alertas (Grafana, usuario admin):\n👉 http://$LOCAL_IP:$GRAFANA_PORT"; fi

whiptail --title "¡Instalación Completada!" --msgbox "El Servidor SRT se ha instalado correctamente y arrancará solo cada vez que enciendas el mini PC.\n\nPuedes acceder a tu panel de control desde cualquier navegador en la red ingresando a:\n\n👉 http://$LOCAL_IP:$WEB_PORT$GRAFANA_TEXT" 18 65

clear
echo "✅ ¡Instalación Finalizada con éxito!"
echo "📍 Panel Web en: http://$LOCAL_IP:$WEB_PORT"
if [ "$INSTALL_MONITORING" = "yes" ]; then echo "📊 Grafana en: http://$LOCAL_IP:$GRAFANA_PORT (usuario admin)"; fi
echo "🎞️ Comprueba Quick Sync con: vainfo"
