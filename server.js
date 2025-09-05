const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Configuración de CORS
const corsOptions = {
    origin: process.env.FRONTEND_URL,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true // Si necesitas enviar cookies o headers de autenticación
};

app.use(cors(corsOptions));

// Configuración de la base de datos PostgreSQL
const pool = new Pool({
    connectionString: process.env.DB_PATH,
    ssl: {
        rejectUnauthorized: false // Necesario para Neon
    }
});

// Configuración del juego
const GAME_CONFIG = {
    MIN_GAME_DURATION:  process.env.MIN_GAME_DURATION, // 10 segundos mínimo
    MAX_GAME_DURATION: process.env.MAX_GAME_DURATION, // 10 minutos máximo
    TOKEN_EXPIRY: process.env.TOKEN_EXPIRY, // 5 minutos para usar el token
    MAX_SCORE: process.env.MAX_SCORE, // Puntuación máxima válida
    MIN_SCORE: process.env.MIN_SCORE // Puntuación mínima válida
};

// Inicializar base de datos
async function initializeDatabase() {
    try {
        // Tabla para las partidas activas
        await pool.query(`CREATE TABLE IF NOT EXISTS active_games (
            id TEXT PRIMARY KEY,
            start_time BIGINT NOT NULL,
            created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
        )`);
        
        // Tabla para el top 3
        await pool.query(`CREATE TABLE IF NOT EXISTS top_scores (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            score INTEGER NOT NULL,
            achieved_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
        )`);
        
        // Tabla para tokens pendientes
        await pool.query(`CREATE TABLE IF NOT EXISTS pending_tokens (
            id TEXT PRIMARY KEY,
            token_hash TEXT NOT NULL,
            score INTEGER NOT NULL,
            game_duration INTEGER NOT NULL,
            expires_at BIGINT NOT NULL
        )`);
        
        console.log('Base de datos inicializada correctamente');
    } catch (error) {
        console.error('Error inicializando la base de datos:', error);
    }
}

// Inicializar la base de datos
initializeDatabase();

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
async function cleanupExpiredData() {
    const now = Date.now();
    
    try {
        // Limpiar tokens expirados
        await pool.query('DELETE FROM pending_tokens WHERE expires_at < $1', [now]);
        
        // Limpiar partidas muy antiguas (más de 1 hora)
        await pool.query('DELETE FROM active_games WHERE created_at < $1', [Math.floor(now / 1000) - 3600]);
    } catch (error) {
        console.error('Error limpiando datos expirados:', error);
    }
}

// Función para obtener el top 3
async function getTop3Scores() {
    try {
        const result = await pool.query(
            'SELECT username, score FROM top_scores ORDER BY score DESC LIMIT 3'
        );
        return { error: null, rows: result.rows };
    } catch (error) {
        return { error, rows: null };
    }
}

// Función para verificar si una puntuación entra en el top 3
async function isTop3Score(score) {
    try {
        const result = await pool.query(
            'SELECT score FROM top_scores ORDER BY score DESC LIMIT 3'
        );
        
        if (result.rows.length < 3) {
            // Hay menos de 3 puntuaciones, siempre entra
            return { error: null, isTop3: true };
        }
        
        const lowestTop3 = result.rows[result.rows.length - 1].score;
        return { error: null, isTop3: score > lowestTop3 };
    } catch (error) {
        return { error, isTop3: false };
    }
}

// Función para actualizar el top 3
async function updateTop3(username, score) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await client.query('INSERT INTO top_scores (username, score) VALUES ($1, $2)', [username, score]);
        
        // Mantener solo el top 3
        await client.query(`
            DELETE FROM top_scores 
            WHERE id NOT IN (
                SELECT id FROM top_scores 
                ORDER BY score DESC 
                LIMIT 3
            )
        `);
        
        await client.query('COMMIT');
        return { error: null };
    } catch (error) {
        await client.query('ROLLBACK');
        return { error };
    } finally {
        client.release();
    }
}

// Limpiar datos expirados cada 5 minutos
setInterval(cleanupExpiredData, 5 * 60 * 1000);

// RUTAS DE LA API

// 1. Iniciar partida
app.post('/api/game/start', async (req, res) => {
    const gameId = generateId();
    const startTime = Date.now();
    
    try {
        await pool.query(
            'INSERT INTO active_games (id, start_time) VALUES ($1, $2)',
            [gameId, startTime]
        );
        
        res.json({ 
            gameId,
            message: 'Partida iniciada correctamente'
        });
        
        console.log("Partida iniciada con ID:", gameId);
    } catch (error) {
        console.error('Error al iniciar partida:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// 2. Terminar partida
app.post('/api/game/end', async (req, res) => {
    const { gameId, score } = req.body;
    const endTime = Date.now();
    
    // Validaciones básicas
    if (!gameId || typeof score !== 'number') {
        return res.status(400).json({ error: 'gameId y score son requeridos' });
    }
    
    if (score < GAME_CONFIG.MIN_SCORE || score > GAME_CONFIG.MAX_SCORE) {
        return res.status(400).json({ error: 'Puntuación fuera del rango válido' });
    }
    
    try {
        // Verificar que la partida existe
        const result = await pool.query(
            'SELECT start_time FROM active_games WHERE id = $1',
            [gameId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Partida no encontrada o expirada' });
        }
        
        const gameDuration = endTime - result.rows[0].start_time;
        
        // Validar duración del juego
        if (gameDuration < GAME_CONFIG.MIN_GAME_DURATION || 
            gameDuration > GAME_CONFIG.MAX_GAME_DURATION) {
            // Eliminar la partida inválida
            await pool.query('DELETE FROM active_games WHERE id = $1', [gameId]);
            return res.status(400).json({ 
                error: 'Duración de partida inválida',
                duration: gameDuration
            });
        }
        
        // Verificar si la puntuación entra en el top 3
        const { error: top3Error, isTop3 } = await isTop3Score(score);
        if (top3Error) {
            console.error('Error al verificar top 3:', top3Error);
            return res.status(500).json({ error: 'Error interno del servidor' });
        }
        
        // Eliminar la partida completada
        await pool.query('DELETE FROM active_games WHERE id = $1', [gameId]);
        
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
        
        await pool.query(
            'INSERT INTO pending_tokens (id, token_hash, score, game_duration, expires_at) VALUES ($1, $2, $3, $4, $5)',
            [gameId, tokenHash, score, gameDuration, expiresAt]
        );
        
        res.json({
            isTop3: true,
            token,
            expiresIn: GAME_CONFIG.TOKEN_EXPIRY,
            message: 'Felicitaciones! Entraste al top 3. Registra tu nombre.'
        });
        
    } catch (error) {
        console.error('Error al terminar partida:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// 3. Registrar nombre en el top 3
app.post('/api/game/register-top3', async (req, res) => {
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
    
    try {
        // Verificar token
        const result = await pool.query(
            'SELECT score, expires_at FROM pending_tokens WHERE id = $1 AND token_hash = $2',
            [gameId, tokenHash]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Token inválido o expirado' });
        }
        
        const tokenData = result.rows[0];
        
        if (now > tokenData.expires_at) {
            // Limpiar token expirado
            await pool.query('DELETE FROM pending_tokens WHERE id = $1', [gameId]);
            return res.status(410).json({ error: 'Token expirado' });
        }
        
        // Registrar en el top 3
        const { error: updateError } = await updateTop3(username.trim(), tokenData.score);
        if (updateError) {
            console.error('Error al actualizar top 3:', updateError);
            return res.status(500).json({ error: 'Error interno del servidor' });
        }
        
        // Limpiar token usado
        await pool.query('DELETE FROM pending_tokens WHERE id = $1', [gameId]);
        
        res.json({
            success: true,
            message: 'Nombre registrado correctamente en el top 3',
            score: tokenData.score
        });
        
    } catch (error) {
        console.error('Error al registrar en top 3:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// 4. Obtener top 3
app.get('/api/leaderboard', async (req, res) => {
    try {
        const { error, rows: scores } = await getTop3Scores();
        if (error) {
            console.error('Error al obtener top 3:', error);
            return res.status(500).json({ error: 'Error interno del servidor' });
        }
        
        res.json({
            leaderboard: scores,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error al obtener top 3:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
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

// Para Vercel, exportar la app
module.exports = app;

// Para desarrollo local
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`🎮 Servidor de puntuaciones ejecutándose en http://localhost:${PORT}`);
        console.log(`📊 Base de datos: PostgreSQL`);
        console.log('🚀 API endpoints disponibles:');
        console.log('   POST /api/game/start - Iniciar partida');
        console.log('   POST /api/game/end - Terminar partida');
        console.log('   POST /api/game/register-top3 - Registrar nombre en top 3');
        console.log('   GET /api/leaderboard - Obtener tabla de puntuaciones');
        console.log('   GET /api/health - Estado del servidor');
    });
}

// Manejo graceful del cierre del servidor
process.on('SIGINT', async () => {
    console.log('\n🔄 Cerrando servidor...');
    try {
        await pool.end();
        console.log('✅ Conexiones de base de datos cerradas correctamente');
    } catch (error) {
        console.error('Error al cerrar las conexiones de base de datos:', error);
    }
    process.exit(0);
});