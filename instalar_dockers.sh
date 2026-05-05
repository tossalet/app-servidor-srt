#!/bin/bash

# Comprobar root
if [ "$EUID" -ne 0 ]; then
  echo "❌ Error: Por favor, ejecuta este instalador con permisos de administrador (sudo)."
  exit
fi

echo "🚀 Iniciando instalación y actualización del Servidor TSST Unificado..."

# 1. Instalar Docker y Docker Compose si no están instalados
if ! command -v docker &> /dev/null; then
    echo "🐳 Instalando Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
fi

if ! command -v docker-compose &> /dev/null; then
    echo "🐳 Instalando Docker Compose..."
    apt-get update
    apt-get install -y docker-compose-plugin docker-compose
fi

echo "📥 Descargando la última versión desde GitHub..."
# Hacemos pull de la imagen unificada
docker-compose pull

echo "▶️ Levantando el servidor..."
# Arrancamos en segundo plano y forzamos a recrear si la imagen ha cambiado
docker-compose up -d --remove-orphans

echo "✅ ¡Listo! El Servidor (y el Panel de Control) están corriendo en el puerto 4000."
echo "Puedes ver el registro de estado con el comando: docker-compose logs -f"
