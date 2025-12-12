// ==========================================
// REDIS CLIENT CONFIGURATION
// ==========================================

const redis = require('redis');

// Redis configuration
const REDIS_CONFIG = {
    socket: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379
    },
    password: process.env.REDIS_PASSWORD || undefined,  // Set trong .env
    database: 0  // Database index (0-15)
};

// Create Redis client
const redisClient = redis.createClient(REDIS_CONFIG);

// Error handler
redisClient.on('error', (err) => {
    console.error('❌ [REDIS] Client Error:', err.message);
});

// Connection events
redisClient.on('connect', () => {
    console.log('🔗 [REDIS] Connecting...');
});

redisClient.on('ready', () => {
    console.log('✅ [REDIS] Client Ready!');
    console.log(`📊 [REDIS] Host: ${REDIS_CONFIG.socket.host}:${REDIS_CONFIG.socket.port}`);
});

redisClient.on('reconnecting', () => {
    console.log('🔄 [REDIS] Reconnecting...');
});

redisClient.on('end', () => {
    console.log('🔌 [REDIS] Connection closed');
});

// Connect to Redis
(async () => {
    try {
        await redisClient.connect();
    } catch (err) {
        console.error('❌ [REDIS] Failed to connect:', err.message);
        console.error('⚠️  [REDIS] Server will fall back to in-memory storage');
    }
})();

// ===== HELPER FUNCTIONS =====

/**
 * Get user data from Redis
 */
async function getUser(userId) {
    try {
        const data = await redisClient.get(`user:${userId}`);
        return data ? JSON.parse(data) : null;
    } catch (err) {
        console.error(`[REDIS] Error getting user ${userId}:`, err);
        return null;
    }
}

/**
 * Save user data to Redis
 */
async function saveUser(userId, userData) {
    try {
        userData.lastUpdate = Date.now();
        await redisClient.set(`user:${userId}`, JSON.stringify(userData));
        return true;
    } catch (err) {
        console.error(`[REDIS] Error saving user ${userId}:`, err);
        return false;
    }
}

/**
 * Update user coins
 */
async function updateUserCoins(userId, coinsChange) {
    try {
        const user = await getUser(userId);
        if (!user) return false;

        user.coins += coinsChange;
        user.lastUpdate = Date.now();

        await saveUser(userId, user);
        return true;
    } catch (err) {
        console.error(`[REDIS] Error updating coins for ${userId}:`, err);
        return false;
    }
}

/**
 * Update user stats (wins, losses, level)
 */
async function updateUserStats(userId, statsUpdate) {
    try {
        const user = await getUser(userId);
        if (!user) return false;

        if (statsUpdate.winCount !== undefined) user.winCount = statsUpdate.winCount;
        if (statsUpdate.lostCount !== undefined) user.lostCount = statsUpdate.lostCount;
        if (statsUpdate.level !== undefined) user.level = statsUpdate.level;
        if (statsUpdate.totalGamesPlayed !== undefined) user.totalGamesPlayed = statsUpdate.totalGamesPlayed;

        await saveUser(userId, user);
        return true;
    } catch (err) {
        console.error(`[REDIS] Error updating stats for ${userId}:`, err);
        return false;
    }
}

/**
 * Delete user from Redis
 */
async function deleteUser(userId) {
    try {
        await redisClient.del(`user:${userId}`);
        return true;
    } catch (err) {
        console.error(`[REDIS] Error deleting user ${userId}:`, err);
        return false;
    }
}

/**
 * Get all users (for leaderboard)
 */
async function getAllUsers() {
    try {
        const keys = await redisClient.keys('user:*');
        const users = [];

        for (const key of keys) {
            const data = await redisClient.get(key);
            if (data) {
                users.push(JSON.parse(data));
            }
        }

        return users;
    } catch (err) {
        console.error('[REDIS] Error getting all users:', err);
        return [];
    }
}

/**
 * Update leaderboard (sorted set by wins)
 */
async function updateLeaderboard(userId, winCount) {
    try {
        await redisClient.zAdd('leaderboard:wins', {
            score: winCount,
            value: userId
        });
        return true;
    } catch (err) {
        console.error('[REDIS] Error updating leaderboard:', err);
        return false;
    }
}

/**
 * Get top N players from leaderboard
 */
async function getTopPlayers(limit = 50) {
    try {
        // Get top players with scores (descending)
        const results = await redisClient.zRangeWithScores(
            'leaderboard:wins',
            0,
            limit - 1,
            { REV: true }
        );

        // Get full user data for each
        const leaderboard = [];
        for (const item of results) {
            const user = await getUser(item.value);
            if (user) {
                leaderboard.push({
                    position: leaderboard.length + 1,
                    user_id: user.userId,
                    user_name: user.userName,
                    numof_win: user.winCount,
                    numof_lose: user.lostCount,
                    user_coin: user.coins
                });
            }
        }

        return leaderboard;
    } catch (err) {
        console.error('[REDIS] Error getting top players:', err);
        return [];
    }
}

/**
 * Get player rank
 */
async function getPlayerRank(userId) {
    try {
        const rank = await redisClient.zRevRank('leaderboard:wins', userId);
        return rank !== null ? rank + 1 : 0;  // rank is 0-indexed
    } catch (err) {
        console.error('[REDIS] Error getting player rank:', err);
        return 0;
    }
}

/**
 * Save session data
 */
async function saveSession(sessionId, sessionData, expirationSeconds = 3600) {
    try {
        await redisClient.setEx(
            `session:${sessionId}`,
            expirationSeconds,
            JSON.stringify(sessionData)
        );
        return true;
    } catch (err) {
        console.error('[REDIS] Error saving session:', err);
        return false;
    }
}

/**
 * Get session data
 */
async function getSession(sessionId) {
    try {
        const data = await redisClient.get(`session:${sessionId}`);
        return data ? JSON.parse(data) : null;
    } catch (err) {
        console.error('[REDIS] Error getting session:', err);
        return null;
    }
}

/**
 * Delete session
 */
async function deleteSession(sessionId) {
    try {
        await redisClient.del(`session:${sessionId}`);
        return true;
    } catch (err) {
        console.error('[REDIS] Error deleting session:', err);
        return false;
    }
}

/**
 * Check if Redis is connected
 */
function isRedisConnected() {
    return redisClient.isReady;
}

/**
 * Get Redis info
 */
async function getRedisInfo() {
    try {
        const info = await redisClient.info();
        return info;
    } catch (err) {
        console.error('[REDIS] Error getting info:', err);
        return null;
    }
}

/**
 * Get database size (number of keys)
 */
async function getDatabaseSize() {
    try {
        const size = await redisClient.dbSize();
        return size;
    } catch (err) {
        console.error('[REDIS] Error getting database size:', err);
        return 0;
    }
}

// Export client and helper functions
module.exports = {
    redisClient,
    isRedisConnected,

    // User operations
    getUser,
    saveUser,
    deleteUser,
    getAllUsers,
    updateUserCoins,
    updateUserStats,

    // Leaderboard operations
    updateLeaderboard,
    getTopPlayers,
    getPlayerRank,

    // Session operations
    saveSession,
    getSession,
    deleteSession,

    // Info operations
    getRedisInfo,
    getDatabaseSize
};
