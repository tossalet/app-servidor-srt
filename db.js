const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const fs = require('fs');

const dbDir = path.join(__dirname, 'data');
if (process.env.NODE_ENV === 'production' || process.env.DOCKER_ENV) {
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = process.env.NODE_ENV === 'production' || process.env.DOCKER_ENV ? path.join(dbDir, 'onpremise.db') : path.resolve(__dirname, 'onpremise.db');

// Carpeta de datos persistentes (BBDD y secreto de sesiones)
const dataDir = path.dirname(dbPath);

let resolveReady;
const ready = new Promise(r => { resolveReady = r; });

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error connecting to SQLite database', err);
    } else {
        console.log('Connected to SQLite database.');
        initDB();
    }
});

function initDB() {
    db.serialize(() => {
        // WAL: las escrituras no bloquean lecturas y hay muchas menos escrituras síncronas a disco
        db.run('PRAGMA journal_mode = WAL');
        db.run('PRAGMA synchronous = NORMAL');

        // Table inputs
        db.run(`CREATE TABLE IF NOT EXISTS inputs (
            channel INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL DEFAULT '',
            provider TEXT NOT NULL DEFAULT '',
            location TEXT NOT NULL DEFAULT '',
            remote TEXT NOT NULL DEFAULT '',
            audiowtdg INTEGER NOT NULL DEFAULT 0,
            wtdgsecs INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            udpsrv INTEGER NOT NULL DEFAULT 0,
            preview_enabled INTEGER NOT NULL DEFAULT 1
        )`);

        // Migration for inputs
        db.run("ALTER TABLE inputs ADD COLUMN preview_enabled INTEGER NOT NULL DEFAULT 1", () => {});
        // Retardo de sincronización por input (ms), aplicado en vivo por el data plane
        db.run("ALTER TABLE inputs ADD COLUMN delay_ms INTEGER NOT NULL DEFAULT 0", () => {});

        // Table outputs
        db.run(`CREATE TABLE IF NOT EXISTS outputs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel INTEGER NOT NULL,
            url TEXT NOT NULL DEFAULT '',
            location TEXT NOT NULL DEFAULT '',
            remote TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            udpsrv INTEGER NOT NULL DEFAULT 0,
            vcodec TEXT NOT NULL DEFAULT 'copy',
            FOREIGN KEY (channel) REFERENCES inputs (channel)
        )`);

        // Migration for existing databases
        db.run("ALTER TABLE outputs ADD COLUMN vcodec TEXT NOT NULL DEFAULT 'copy'", () => {});

        // Table ports
        db.run(`CREATE TABLE IF NOT EXISTS ports (
            chanMin INTEGER NOT NULL DEFAULT 1,
            chanMax INTEGER NOT NULL DEFAULT 20000,
            udpMin INTEGER NOT NULL DEFAULT 1024,
            udpMax INTEGER NOT NULL DEFAULT 49151,
            rtmpPort INTEGER NOT NULL DEFAULT 1935
        )`);

        // Migration for ports
        db.run("ALTER TABLE ports ADD COLUMN rtmpPort INTEGER NOT NULL DEFAULT 1935", () => {});

        // Table users
        db.run(`CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            role INTEGER NOT NULL DEFAULT 2,
            email TEXT NOT NULL DEFAULT ''
        )`);

        // Fuerza el cambio de contraseña en el primer login (contraseñas por defecto o débiles)
        db.run("ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0", () => {});

        // Valores iniciales sólo si las tablas están vacías. Sólo se crea admin/admin (cambio obligatorio
        // al entrar); auth.js cifra la contraseña al arrancar.
        db.run(`INSERT INTO users (username, password, role, must_change)
                SELECT 'admin', 'admin', 4, 1 WHERE NOT EXISTS (SELECT 1 FROM users)`);
        db.run(`INSERT INTO ports (chanMin, chanMax, udpMin, udpMax)
                SELECT 1, 20000, 1024, 49151 WHERE NOT EXISTS (SELECT 1 FROM ports)`);

        // Al ir en serie, esto se ejecuta cuando todo lo anterior ha terminado
        db.run('SELECT 1', () => resolveReady());
    });
}

module.exports = db;
// Se resuelve cuando tablas y migraciones están listas
db.ready = ready;
db.dataDir = dataDir;
