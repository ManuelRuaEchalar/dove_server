const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// Configuración de la base de datos
const dbPath = path.join(__dirname, 'game_scores.db');
const db = new sqlite3.Database(dbPath);

// Configuración del juego
const GAME_CONFIG = {
    MIN_GAME_DURATION: 1, // 10 segundos mínimo
    MAX_GAME_DURATION: 600000, // 10 minutos máximo
    TOKEN_EXPIRY: 300000, // 5 minutos para usar el token
    MAX_SCORE: 999999, // Puntuación máxima válida
    MIN_SCORE: 0 // Puntuación mínima válida
};

// Inicializar base de datos
db.serialize(() => {
    // Tabla para las partidas activas
    db.run(`CREATE TABLE IF NOT EXISTS active_games (
        id TEXT PRIMARY KEY,
        start_time INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s','now'))
    )`);
    
    // Tabla para el top 3
    db.run(`CREATE TABLE IF NOT EXISTS top_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        score INTEGER NOT NULL,
        achieved_at INTEGER DEFAULT (strftime('%s','now'))
    )`);
    
    // Tabla para tokens pendientes
    db.run(`CREATE TABLE IF NOT EXISTS pending_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        score INTEGER NOT NULL,
        game_duration INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    )`);
});

// Función para generar ID único
function generateId() {
    return crypto.randomUUID();
}

// Función para generar token seguro
function generateSecureToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Función para hashear token
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// Función para limpiar datos expirados
function cleanupExpiredData() {
    const now = Date.now();
    
    // Limpiar tokens expirados
    db.run('DELETE FROM pending_tokens WHERE expires_at < ?', [now]);
    
    // Limpiar partidas muy antiguas (más de 1 hora)
    db.run('DELETE FROM active_games WHERE created_at < ?', [Math.floor(now / 1000) - 3600]);
}

// Función para obtener el top 3
function getTop3Scores(callback) {
    db.all(
        'SELECT username, score FROM top_scores ORDER BY score DESC LIMIT 3',
        [],
        callback
    );
}

// Función para verificar si una puntuación entra en el top 3
function isTop3Score(score, callback) {
    db.all(
        'SELECT score FROM top_scores ORDER BY score DESC LIMIT 3',
        [],
        (err, rows) => {
            if (err) return callback(err, false);
            
            if (rows.length < 3) {
                // Hay menos de 3 puntuaciones, siempre entra
                return callback(null, true);
            }
            
            const lowestTop3 = rows[rows.length - 1].score;
            callback(null, score > lowestTop3);
        }
    );
}

// Función para actualizar el top 3
function updateTop3(username, score, callback) {
    db.serialize(() => {
        db.run('INSERT INTO top_scores (username, score) VALUES (?, ?)', [username, score]);
        
        // Mantener solo el top 3
        db.run(`
            DELETE FROM top_scores 
            WHERE id NOT IN (
                SELECT id FROM top_scores 
                ORDER BY score DESC 
                LIMIT 3
            )
        `, callback);
    });
}

// Limpiar datos expirados cada 5 minutos
setInterval(cleanupExpiredData, 5 * 60 * 1000);

// RUTAS DE LA API

// 1. Iniciar partida
app.post('/api/game/start', (req, res) => {
    const gameId = generateId();
    const startTime = Date.now();
    
    db.run(
        'INSERT INTO active_games (id, start_time) VALUES (?, ?)',
        [gameId, startTime],
        function(err) {
            if (err) {
                console.error('Error al iniciar partida:', err);
                return res.status(500).json({ error: 'Error interno del servidor' });
            }
            
            res.json({ 
                gameId,
                message: 'Partida iniciada correctamente'
            });
        }
    );
    console.log("Partida iniciada con ID:", gameId);
});

// 2. Terminar partida
app.post('/api/game/end', (req, res) => {
    const { gameId, score } = req.body;
    const endTime = Date.now();
    
    // Validaciones básicas
    if (!gameId || typeof score !== 'number') {
        return res.status(400).json({ error: 'gameId y score son requeridos' });
    }
    
    if (score < GAME_CONFIG.MIN_SCORE || score > GAME_CONFIG.MAX_SCORE) {
        return res.status(400).json({ error: 'Puntuación fuera del rango válido' });
    }
    
    // Verificar que la partida existe
    db.get(
        'SELECT start_time FROM active_games WHERE id = ?',
        [gameId],
        (err, row) => {
            if (err) {
                console.error('Error al buscar partida:', err);
                return res.status(500).json({ error: 'Error interno del servidor' });
            }
            
            if (!row) {
                return res.status(404).json({ error: 'Partida no encontrada o expirada' });
            }
            
            const gameDuration = endTime - row.start_time;
            
            // Validar duración del juego
            if (gameDuration < GAME_CONFIG.MIN_GAME_DURATION || 
                gameDuration > GAME_CONFIG.MAX_GAME_DURATION) {
                // Eliminar la partida inválida
                db.run('DELETE FROM active_games WHERE id = ?', [gameId]);
                return res.status(400).json({ 
                    error: 'Duración de partida inválida',
                    duration: gameDuration
                });
            }
            
            // Verificar si la puntuación entra en el top 3
            isTop3Score(score, (err, isTop3) => {
                if (err) {
                    console.error('Error al verificar top 3:', err);
                    return res.status(500).json({ error: 'Error interno del servidor' });
                }
                
                // Eliminar la partida completada
                db.run('DELETE FROM active_games WHERE id = ?', [gameId]);
                
                if (!isTop3) {
                    return res.json({ 
                        isTop3: false,
                        message: 'Puntuación registrada, pero no entra en el top 3'
                    });
                }
                
                // Generar token para top 3
                const token = generateSecureToken();
                const tokenHash = hashToken(token);
                const expiresAt = Date.now() + GAME_CONFIG.TOKEN_EXPIRY;
                
                db.run(
                    'INSERT INTO pending_tokens (id, token_hash, score, game_duration, expires_at) VALUES (?, ?, ?, ?, ?)',
                    [gameId, tokenHash, score, gameDuration, expiresAt],
                    (err) => {
                        if (err) {
                            console.error('Error al guardar token:', err);
                            return res.status(500).json({ error: 'Error interno del servidor' });
                        }
                        
                        res.json({
                            isTop3: true,
                            token,
                            expiresIn: GAME_CONFIG.TOKEN_EXPIRY,
                            message: 'Felicitaciones! Entraste al top 3. Registra tu nombre.'
                        });
                    }
                );
            });
        }
    );
});

// 3. Registrar nombre en el top 3
app.post('/api/game/register-top3', (req, res) => {
    const { gameId, username, token } = req.body;
    
    // Validaciones
    if (!gameId || !username || !token) {
        return res.status(400).json({ error: 'gameId, username y token son requeridos' });
    }
    
    if (typeof username !== 'string' || username.trim().length < 1 || username.length > 50) {
        return res.status(400).json({ error: 'El nombre debe tener entre 1 y 50 caracteres' });
    }
    
    const tokenHash = hashToken(token);
    const now = Date.now();
    
    // Verificar token
    db.get(
        'SELECT score, expires_at FROM pending_tokens WHERE id = ? AND token_hash = ?',
        [gameId, tokenHash],
        (err, row) => {
            if (err) {
                console.error('Error al verificar token:', err);
                return res.status(500).json({ error: 'Error interno del servidor' });
            }
            
            if (!row) {
                return res.status(404).json({ error: 'Token inválido o expirado' });
            }
            
            if (now > row.expires_at) {
                // Limpiar token expirado
                db.run('DELETE FROM pending_tokens WHERE id = ?', [gameId]);
                return res.status(410).json({ error: 'Token expirado' });
            }
            
            // Registrar en el top 3
            updateTop3(username.trim(), row.score, (err) => {
                if (err) {
                    console.error('Error al actualizar top 3:', err);
                    return res.status(500).json({ error: 'Error interno del servidor' });
                }
                
                // Limpiar token usado
                db.run('DELETE FROM pending_tokens WHERE id = ?', [gameId]);
                
                res.json({
                    success: true,
                    message: 'Nombre registrado correctamente en el top 3',
                    score: row.score
                });
            });
        }
    );
});

// 4. Obtener top 3
app.get('/api/leaderboard', (req, res) => {
    getTop3Scores((err, scores) => {
        if (err) {
            console.error('Error al obtener top 3:', err);
            return res.status(500).json({ error: 'Error interno del servidor' });
        }
        
        res.json({
            leaderboard: scores,
            timestamp: new Date().toISOString()
        });
    });
});

// 5. Ruta de estado del servidor
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Manejo de errores global
app.use((err, req, res, next) => {
    console.error('Error no manejado:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
});

// Manejo de rutas no encontradas
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🎮 Servidor de puntuaciones ejecutándose en http://localhost:${PORT}`);
    console.log(`📊 Base de datos: ${dbPath}`);
    console.log('🚀 API endpoints disponibles:');
    console.log('   POST /api/game/start - Iniciar partida');
    console.log('   POST /api/game/end - Terminar partida');
    console.log('   POST /api/game/register-top3 - Registrar nombre en top 3');
    console.log('   GET /api/leaderboard - Obtener tabla de puntuaciones');
    console.log('   GET /api/health - Estado del servidor');
});

// Manejo graceful del cierre del servidor
process.on('SIGINT', () => {
    console.log('\n🔄 Cerrando servidor...');
    db.close((err) => {
        if (err) {
            console.error('Error al cerrar la base de datos:', err);
        } else {
            console.log('✅ Base de datos cerrada correctamente');
        }
        process.exit(0);
    });
});