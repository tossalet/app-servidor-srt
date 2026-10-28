# Debian 12 (Bookworm): FFmpeg 5.1 con libsrt y VAAPI, Node 22 LTS
FROM node:22-bookworm-slim

# FFmpeg, srt-live-transmit (srt-tools), drivers Intel Quick Sync (VAAPI) y utilidades de red
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    srt-tools \
    intel-media-va-driver \
    i965-va-driver \
    sqlite3 \
    iproute2 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create working directory
WORKDIR /usr/src/app

# Copy package info
COPY package*.json ./

# Install npm dependencies (sin las de desarrollo)
RUN npm ci --omit=dev

# Copy application files
COPY . .

ENV NODE_ENV=production

# Expose Web Panel & API port
EXPOSE 4000
# Expose default SRT/UDP port ranges (example: 1024-50000 range, usually map via host networking anyway)
EXPOSE 1024-50000/udp

# Node como PID 1 recibe SIGTERM y cierra las grabaciones antes de salir
CMD ["node", "server.js"]
