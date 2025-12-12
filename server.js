const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();  // Load environment variables

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Trong production nên set specific domain
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

// ===== REDIS CLIENT =====
const {
    isRedisConnected,
    getUser,
    saveUser,
    deleteUser,
    getAllUsers,
    updateUserCoins,
    updateUserStats,
    updateLeaderboard,
    getTopPlayers,
    getDatabaseSize
} = require('./redis-client');

// ===== IN-MEMORY STORAGE (Fallback nếu Redis không available) =====
const users = new Map(); // userId -> userData (fallback)
const rooms = new Map(); // roomId -> roomData
const userSockets = new Map(); // userId -> socketId

// ===== CONSTANTS =====
const GAME_STATUS = {
    WAITING: 'waiting',
    PLAYING: 'playing',
    FINISHED: 'finished'
};

const PLAYER_STATUS = {
    PLAYING: 0,
    WIN: 1,
    LEFT: 2,
    TIMEOUT: 3
};

const MAX_PLAYERS = 4;
const TURN_TIMEOUT = 30000; // 30 seconds

// ===== HELPER FUNCTIONS =====
function createRoom(roomId, hostUserId, betAmount, playerCount) {
    return {
        roomId: roomId,
        hostUserId: hostUserId,
        betAmount: betAmount,
        maxPlayers: playerCount,
        status: GAME_STATUS.WAITING,
        players: [],
        currentTurn: 0,
        turnTimer: null, // Timer for auto turn change
        gameData: {
            lastDice: 0,
            moves: []
        },
        createdAt: Date.now()
    };
}

function createPlayer(userId, userName, peerId, socketId) {
    return {
        userId: userId,
        userName: userName,
        peerId: peerId,
        socketId: socketId,
        status: PLAYER_STATUS.PLAYING,
        numoftimeout: 0, // Track number of timeouts
        joinedAt: Date.now()
    };
}

function findAvailableRoom(betAmount, playerCount) {
    for (let [roomId, room] of rooms.entries()) {
        if (room.status === GAME_STATUS.WAITING &&
            room.betAmount === betAmount &&
            room.maxPlayers === playerCount &&
            room.players.length < playerCount) {
            return room;
        }
    }
    return null;
}

function getNextTurn(room) {
    const activePlayers = room.players.filter(p =>
        p.status === PLAYER_STATUS.PLAYING || p.status === PLAYER_STATUS.WIN
    );

    if (activePlayers.length === 0) return -1;

    let nextIndex = (room.currentTurn + 1) % room.players.length;
    let attempts = 0;

    while (attempts < room.players.length) {
        const player = room.players[nextIndex];
        if (player && (player.status === PLAYER_STATUS.PLAYING)) {
            return nextIndex;
        }
        nextIndex = (nextIndex + 1) % room.players.length;
        attempts++;
    }

    return -1;
}

function startTurnTimer(room) {
    // Clear existing timer
    if (room.turnTimer) {
        clearTimeout(room.turnTimer);
    }

    // Set new timer for current turn
    room.turnTimer = setTimeout(async () => {
        console.log(`[TURN_TIMEOUT] Room ${room.roomId}, Peer ${room.players[room.currentTurn]?.peerId} timeout`);

        const currentPlayer = room.players[room.currentTurn];
        if (currentPlayer && currentPlayer.status === PLAYER_STATUS.PLAYING) {
            // Increase timeout counter
            currentPlayer.numoftimeout++;

            // Notify timeout counter
            io.to(room.roomId).emit('user_timeout_counter', JSON.stringify({
                peer_id: currentPlayer.peerId,
                numoftimeout: currentPlayer.numoftimeout
            }));

            // After 3 timeouts, mark as timeout and remove from game
            if (currentPlayer.numoftimeout >= 3) {
                currentPlayer.status = PLAYER_STATUS.TIMEOUT;
                io.to(room.roomId).emit('user_timeout', JSON.stringify(currentPlayer.peerId));
                console.log(`[TIMEOUT] Player ${currentPlayer.userName} (peer ${currentPlayer.peerId}) marked as timeout after 3 strikes`);

                // Check if only 1 player remaining after timeout
                const activeCount = room.players.filter(p => p.status === PLAYER_STATUS.PLAYING).length;
                console.log(`[TIMEOUT_CHECK] Active players remaining: ${activeCount}`);

                if (activeCount === 1) {
                    // Find the last remaining player
                    const winner = room.players.find(p => p.status === PLAYER_STATUS.PLAYING);
                    if (winner) {
                        winner.status = PLAYER_STATUS.WIN;
                        console.log(`[AUTO_WIN] Player ${winner.userName} (peer ${winner.peerId}) wins - all opponents timeout`);

                        // Send win notification to all players
                        io.to(room.roomId).emit('win_game', JSON.stringify(winner.peerId));

                        // End game
                        clearTurnTimer(room);
                        room.status = GAME_STATUS.FINISHED;

                        // Send game over with full ranking
                        setTimeout(async () => {
                            const results = calculateGameResults(room);
                            await updatePlayerCoinsAndStats(room, results);
                            io.to(room.roomId).emit('game_over', JSON.stringify(results));
                            console.log(`[GAME_OVER] Results: ${JSON.stringify(results)}`);
                        }, 2000); // Give 2 seconds to show win animation

                        return; // Don't continue to turn change
                    }
                } else if (activeCount === 0) {
                    // All players timeout
                    clearTurnTimer(room);
                    const results = calculateGameResults(room);
                    await updatePlayerCoinsAndStats(room, results);
                    io.to(room.roomId).emit('game_over', JSON.stringify(results));
                    console.log(`[GAME_OVER] All timeout - Results: ${JSON.stringify(results)}`);
                    return;
                }
            }

            // Auto change turn (only if game not ended)
            const nextTurn = getNextTurn(room);
            if (nextTurn !== -1) {
                room.currentTurn = nextTurn;
                const nextPlayer = room.players[nextTurn];
                io.to(room.roomId).emit('turn_changed', JSON.stringify(nextPlayer.peerId));
                // console.log(`[AUTO_TURN_CHANGE] Room ${room.roomId}, Next turn: Peer ${nextPlayer.peerId}`);

                // Start timer for next turn
                startTurnTimer(room);
            } else {
                // No active players - game over
                clearTurnTimer(room);
                const results = calculateGameResults(room);
                await updatePlayerCoinsAndStats(room, results);
                io.to(room.roomId).emit('game_over', JSON.stringify(results));
                console.log(`[GAME_OVER] No active players - Results: ${JSON.stringify(results)}`);
            }
        }
    }, TURN_TIMEOUT);
}

function clearTurnTimer(room) {
    if (room.turnTimer) {
        clearTimeout(room.turnTimer);
        room.turnTimer = null;
    }
}

function calculateGameResults(room) {
    // Calculate rankings and winning coins
    const betAmount = room.betAmount;
    const playerCount = room.maxPlayers;

    // Sort players: WIN first, then PLAYING, then TIMEOUT/LEFT
    const sortedPlayers = [...room.players].sort((a, b) => {
        if (a.status === PLAYER_STATUS.WIN && b.status !== PLAYER_STATUS.WIN) return -1;
        if (a.status !== PLAYER_STATUS.WIN && b.status === PLAYER_STATUS.WIN) return 1;
        return 0;
    });

    // Calculate winning coins based on ranking
    const results = sortedPlayers.map((player, index) => {
        let winning_coin = 0;
        let player_rank = index + 1;

        if (player.status === PLAYER_STATUS.WIN) {
            if (playerCount === 2) {
                // 2 players: Winner gets 2x bet
                winning_coin = betAmount * 2;
            } else if (playerCount === 4) {
                // 4 players: 1st gets 3x, 2nd gets 1x
                if (player_rank === 1) {
                    winning_coin = betAmount * 3;
                } else if (player_rank === 2) {
                    winning_coin = betAmount;
                }
            }
        }

        return {
            user_name: player.userName,
            user_id: player.userId,
            winning_coin: winning_coin,
            player_rank: player_rank,
            player_status: player.status
        };
    });

    return results;
}

// Update player coins and stats after game ends
async function updatePlayerCoinsAndStats(room, results) {
    for (const result of results) {
        let user;

        // Get user from Redis or Memory
        if (isRedisConnected()) {
            user = await getUser(result.user_id);
        } else {
            user = users.get(result.user_id);
        }

        if (!user) continue;

        // Add winning coins
        user.coins += result.winning_coin;

        // Update stats
        user.totalGamesPlayed = (user.totalGamesPlayed || 0) + 1;

        if (result.player_status === PLAYER_STATUS.WIN) {
            user.winCount++;
            // Level up every 10 wins
            user.level = Math.floor(1 + (user.winCount / 10));
        } else {
            user.lostCount++;
        }

        // Save back to storage
        if (isRedisConnected()) {
            await saveUser(result.user_id, user);
            await updateLeaderboard(result.user_id, user.winCount);
        } else {
            users.set(result.user_id, user);
        }

        console.log(`[COINS_UPDATE] ${user.userName}: +${result.winning_coin} (Total: ${user.coins}) | W/L: ${user.winCount}/${user.lostCount}`);
    }
}

// ===== SOCKET.IO CONNECTION =====
io.on('connection', (socket) => {
    console.log(`[CONNECT] Socket connected: ${socket.id}`);

    // ===== USER AUTHENTICATION =====
    socket.on('add_user', async (data) => {
        try {
            const { user_id, user_name, fcm_token } = JSON.parse(data);

            // Chỉ lưu socket mapping, không tạo user data ở đây
            // User data sẽ được tạo khi gọi get_userdata
            userSockets.set(user_id, socket.id);
            socket.userId = user_id;

            // Generate auth token (in production, use JWT)
            const authToken = `token_${user_id}_${Date.now()}`;

            socket.emit('auth_token', authToken);
            console.log(`[ADD_USER] User ${user_name} (${user_id}) connected - Socket: ${socket.id}`);

        } catch (error) {
            console.error('[ADD_USER] Error:', error);
            socket.emit('error', { message: 'Failed to add user' });
        }
    });

    // ===== GET USER DATA =====
    socket.on('get_userdata', async (data) => {
        try {
            const { user_id, user_name } = JSON.parse(data);

            // Try Redis first
            let user = isRedisConnected() ? await getUser(user_id) : users.get(user_id);

            // Nếu chưa có user, tạo mới với giá trị mặc định
            if (!user) {
                // const userName = `Guest${Math.floor(Math.random() * 10000)}`;
                user = {
                    userId: user_id,
                    userName: user_name,
                    fcmToken: '',
                    coins: 1000,
                    level: 1,
                    winCount: 0,
                    lostCount: 0,
                    totalGamesPlayed: 0,
                    createdAt: Date.now()
                };

                // Save to Redis or Memory
                if (isRedisConnected()) {
                    await saveUser(user_id, user);
                    console.log(`[NEW_USER] Created via get_userdata: ${userName} (${user_id}) with 1000 coins (Redis)`);
                } else {
                    users.set(user_id, user);
                    console.log(`[NEW_USER] Created via get_userdata: ${userName} (${user_id}) with 1000 coins (Memory)`);
                }
            } else {
                console.log(`[GET_USERDATA] ${user.userName} - Coins: ${user.coins}, W/L: ${user.winCount}/${user.lostCount}`);
            }

            // Return full user data including coins and stats
            const userData = {
                user_id: user.userId,
                user_name: user.userName,
                user_coin: user.coins,
                numof_win: user.winCount,
                numof_lose: user.lostCount,
                user_level: user.level,
                total_games: user.totalGamesPlayed || 0
            };
            socket.emit('user_data', JSON.stringify(userData));

        } catch (error) {
            console.error('[GET_USERDATA] Error:', error);
            socket.emit('error', { message: 'Failed to get user data' });
        }
    });

    // ===== MATCHMAKING - REQUEST JOIN ROOM =====
    socket.on('request_join', async (data) => {
        try {
            const jsonData = JSON.parse(data);
            const user_id = jsonData.user_id;
            const user_name = jsonData.user_name;
            const bet_amount = jsonData.room_coin_value; // Client sends "room_coin_value"
            const player_count = jsonData.room_players_size; // Client sends "room_players_size"

            // Check if user has enough coins (Redis or Memory)
            let user = isRedisConnected() ? await getUser(user_id) : users.get(user_id);

            if (!user) {
                socket.emit('error', JSON.stringify({ message: 'User not found' }));
                return;
            }

            if (user.coins < bet_amount) {
                socket.emit('insufficient_coins', JSON.stringify({
                    required: bet_amount,
                    current: user.coins
                }));
                console.log(`[JOIN_FAILED] ${user_name} insufficient coins: ${user.coins}/${bet_amount}`);
                return;
            }

            // Deduct bet amount from user coins
            user.coins -= bet_amount;

            // Save back to storage
            if (isRedisConnected()) {
                await saveUser(user_id, user);
            } else {
                users.set(user_id, user);
            }

            console.log(`[COINS_DEDUCTED] ${user_name}: -${bet_amount} (Remaining: ${user.coins})`);

            // Find available room
            let room = findAvailableRoom(bet_amount, player_count);

            // Create new room if none available
            if (!room) {
                const roomId = uuidv4();
                room = createRoom(roomId, user_id, bet_amount, player_count);
                rooms.set(roomId, room);
                // console.log(`[CREATE_ROOM] New room created: ${roomId}`);
            }

            // Add player to room
            const player = createPlayer(user_id, user_name, room.players.length, socket.id);
            room.players.push(player);

            // Join socket room
            socket.join(room.roomId);
            socket.currentRoomId = room.roomId;

            // console.log(`[PLAYER_JOINED] ${user_name} joined room ${room.roomId} as peer ${player.peerId}`);

            // If room is full, start game
            if (room.players.length === room.maxPlayers) {
                room.status = GAME_STATUS.PLAYING;
                room.currentTurn = 0; // First player starts

                // Send game start to all players with complete player data
                const gameStartData = {
                    room_id: room.roomId,
                    room_coin: bet_amount,
                    userdata: room.players.map(p => {
                        // Get user data or use defaults
                        const userData = users.get(p.userId) || {
                            user_coin: 1000,
                            numof_win: 0,
                            numof_lose: 0,
                            user_level: 1
                        };

                        return {
                            peer_id: p.peerId,
                            user_id: p.userId,
                            user_name: p.userName,
                            user_coin: userData.user_coin || 1000,
                            numof_win: userData.numof_win || 0,
                            numof_lose: userData.numof_lose || 0,
                            user_level: userData.user_level || 1,
                            login_type: userData.login_type || 'Guest'
                        };
                    })
                };

                io.to(room.roomId).emit('game_start', JSON.stringify(gameStartData));
                // console.log(`[GAME_START] Room ${room.roomId} started with ${room.players.length} players`);

                // Start turn timer for first player
                startTurnTimer(room);
            }

        } catch (error) {
            console.error('[REQUEST_JOIN] Error:', error);
            socket.emit('error', { message: 'Failed to join room' });
        }
    });

    // ===== FRIEND ROOM - CREATE =====
    socket.on('friend_create_room', async (data) => {
        try {
            const jsonData = JSON.parse(data);
            const user_id = jsonData.user_id;
            const user_name = jsonData.user_name;
            const bet_amount = jsonData.room_coin_value; // Client sends "room_coin_value"
            const player_count = jsonData.room_players_size; // Client sends "room_players_size"
            const room_code = jsonData.room_code;

            // Check if user has enough coins
            const user = users.get(user_id);
            if (!user) {
                socket.emit('friend_error_response', { message: 'User not found' });
                return;
            }

            if (user.coins < bet_amount) {
                socket.emit('insufficient_coins', JSON.stringify({
                    required: bet_amount,
                    current: user.coins
                }));
                console.log(`[FRIEND_CREATE_FAILED] ${user_name} insufficient coins: ${user.coins}/${bet_amount}`);
                return;
            }

            // Deduct bet amount
            user.coins -= bet_amount;
            console.log(`[COINS_DEDUCTED] ${user_name}: -${bet_amount} (Remaining: ${user.coins})`);

            const roomId = room_code || uuidv4().substring(0, 6).toUpperCase();
            const room = createRoom(roomId, user_id, bet_amount, player_count);
            rooms.set(roomId, room);

            const player = createPlayer(user_id, user_name, 0, socket.id);
            room.players.push(player);

            socket.join(roomId);
            socket.currentRoomId = roomId;

            socket.emit('friend_room_code', JSON.stringify({ room_code: roomId }));
            // console.log(`[FRIEND_CREATE] Room created: ${roomId} by ${user_name}`);

        } catch (error) {
            console.error('[FRIEND_CREATE] Error:', error);
            socket.emit('friend_error_response', { message: 'Failed to create room' });
        }
    });

    // ===== FRIEND ROOM - JOIN =====
    socket.on('friend_join_room', async (data) => {
        try {
            const { user_id, user_name, room_code } = JSON.parse(data);

            const room = rooms.get(room_code);

            if (!room) {
                socket.emit('friend_error_response', { message: 'Room not found' });
                return;
            }

            if (room.players.length >= room.maxPlayers) {
                socket.emit('friend_error_response', { message: 'Room is full' });
                return;
            }

            // Check if user has enough coins
            const user = users.get(user_id);
            if (!user) {
                socket.emit('friend_error_response', { message: 'User not found' });
                return;
            }

            if (user.coins < room.betAmount) {
                socket.emit('insufficient_coins', JSON.stringify({
                    required: room.betAmount,
                    current: user.coins
                }));
                console.log(`[FRIEND_JOIN_FAILED] ${user_name} insufficient coins: ${user.coins}/${room.betAmount}`);
                return;
            }

            // Deduct bet amount
            user.coins -= room.betAmount;
            console.log(`[COINS_DEDUCTED] ${user_name}: -${room.betAmount} (Remaining: ${user.coins})`);


            if (room.status !== GAME_STATUS.WAITING) {
                socket.emit('friend_error_response', { message: 'Game already started' });
                return;
            }

            const player = createPlayer(user_id, user_name, room.players.length, socket.id);
            room.players.push(player);

            socket.join(room_code);
            socket.currentRoomId = room_code;

            // Notify all players in room
            io.to(room_code).emit('player_joined', JSON.stringify({
                peer_id: player.peerId,
                user_name: user_name,
                player_count: room.players.length,
                max_players: room.maxPlayers
            }));

            // console.log(`[FRIEND_JOIN] ${user_name} joined room ${room_code}`);

            // Start game if room full
            if (room.players.length === room.maxPlayers) {
                room.status = GAME_STATUS.PLAYING;
                room.currentTurn = 0;

                const gameStartData = {
                    room_id: room.roomId,
                    room_coin: room.betAmount,
                    userdata: room.players.map(p => {
                        const userData = users.get(p.userId) || {
                            user_coin: 1000,
                            numof_win: 0,
                            numof_lose: 0,
                            user_level: 1
                        };

                        return {
                            peer_id: p.peerId,
                            user_id: p.userId,
                            user_name: p.userName,
                            user_coin: userData.user_coin || 1000,
                            numof_win: userData.numof_win || 0,
                            numof_lose: userData.numof_lose || 0,
                            user_level: userData.user_level || 1,
                            login_type: userData.login_type || 'Guest'
                        };
                    })
                };

                io.to(room_code).emit('game_start', JSON.stringify(gameStartData));
            }

        } catch (error) {
            console.error('[FRIEND_JOIN] Error:', error);
            socket.emit('friend_error_response', { message: 'Failed to join room' });
        }
    });

    // ===== GAME ACTIONS - DICE =====
    socket.on('dice_send', (data) => {
        try {
            const { room_id, peer_id, dice_face } = JSON.parse(data);
            const room = rooms.get(room_id);

            if (!room) return;

            // Restart turn timer when player rolls dice
            clearTurnTimer(room);
            startTurnTimer(room);

            room.gameData.lastDice = dice_face;

            // Broadcast to other players in room
            socket.to(room_id).emit('dice_recieved', JSON.stringify({
                peer_id: peer_id,
                dice_face: dice_face
            }));

            // console.log(`[DICE] Room ${room_id}, Peer ${peer_id} rolled ${dice_face}`);

        } catch (error) {
            console.error('[DICE_SEND] Error:', error);
        }
    });

    // ===== GAME ACTIONS - TOKEN MOVE =====
    socket.on('token_send', (data) => {
        try {
            const { room_id, peer_id, token_id, token_value } = JSON.parse(data);
            const room = rooms.get(room_id);

            if (!room) return;

            // Restart turn timer when player makes a move
            clearTurnTimer(room);
            startTurnTimer(room);

            // Store move
            room.gameData.moves.push({
                peerId: peer_id,
                tokenId: token_id,
                tokenValue: token_value,
                timestamp: Date.now()
            });

            // Broadcast to other players
            socket.to(room_id).emit('token_recieved', JSON.stringify({
                peer_id: peer_id,
                token_id: token_id,
                token_value: token_value,
                dice_face: room.gameData.lastDice
            }));

            console.log(`[TOKEN] Room ${room_id}, Peer ${peer_id} moved token ${token_id} to ${token_value}`);

        } catch (error) {
            console.error('[TOKEN_SEND] Error:', error);
        }
    });

    // ===== GAME ACTIONS - TOKEN RESET =====
    socket.on('token_reset', (data) => {
        try {
            const { room_id, peer_id, token_id, token_value } = JSON.parse(data);

            // Broadcast token reset to OTHER players only (not sender)
            // peer_id is the player whose token got KILLED (should receive reset)
            // socket.to(room_id) excludes sender, so only the killed player receives it
            socket.to(room_id).emit('token_recieved', JSON.stringify({
                peer_id: peer_id,
                token_id: token_id,
                token_value: token_value,
                dice_face: 0
            }));

            console.log(`[TOKEN_RESET] Room ${room_id}, Peer ${peer_id} reset token ${token_id}`);

        } catch (error) {
            console.error('[TOKEN_RESET] Error:', error);
        }
    });

    // ===== GAME ACTIONS - CHANGE TURN =====
    socket.on('change_turn', (data) => {
        try {
            const { room_id, peer_id } = JSON.parse(data);
            const room = rooms.get(room_id);

            if (!room) return;

            // Clear current turn timer
            clearTurnTimer(room);

            // Get next turn
            const nextTurn = getNextTurn(room);

            if (nextTurn === -1) {
                // Game over - no active players
                io.to(room_id).emit('game_over', JSON.stringify({ reason: 'No active players' }));
                return;
            }

            room.currentTurn = nextTurn;

            // Broadcast turn change - send as JSON string to match client parsing
            const currentPlayer = room.players[nextTurn];
            io.to(room_id).emit('turn_changed', JSON.stringify(currentPlayer.peerId));

            // console.log(`[TURN_CHANGE] Room ${room_id}, Turn changed to peer ${currentPlayer.peerId}`);

            // Start timer for next turn
            startTurnTimer(room);

        } catch (error) {
            console.error('[CHANGE_TURN] Error:', error);
        }
    });

    // ===== GAME ACTIONS - WIN =====
    socket.on('win_game', async (data) => {
        try {
            const { room_id, peer_id, player_rank } = JSON.parse(data);
            const room = rooms.get(room_id);

            if (!room) return;

            // Update player status
            const player = room.players[peer_id];
            if (player) {
                player.status = PLAYER_STATUS.WIN;
            }

            // Broadcast win
            socket.to(room_id).emit('win_game', JSON.stringify(peer_id));

            console.log(`[WIN] Room ${room_id}, Peer ${peer_id} won with rank ${player_rank}`);

            // Check if game is over (only 1 player left or all finished)
            const playingCount = room.players.filter(p => p.status === PLAYER_STATUS.PLAYING).length;

            if (playingCount <= 1) {
                room.status = GAME_STATUS.FINISHED;

                // Clear turn timer when game ends
                clearTurnTimer(room);

                // Calculate results with ranking and winning coins
                const results = calculateGameResults(room);

                // Update player coins and stats
                await updatePlayerCoinsAndStats(room, results);

                io.to(room_id).emit('game_over', JSON.stringify(results));
                // console.log(`[GAME_OVER] Room ${room_id} finished`);

                // Clean up room after delay
                setTimeout(() => {
                    rooms.delete(room_id);
                    // console.log(`[CLEANUP] Room ${room_id} deleted`);
                }, 10000);
            }

        } catch (error) {
            console.error('[WIN_GAME] Error:', error);
        }
    });

    // ===== GAME ACTIONS - LEAVE ROOM =====
    socket.on('leave_room', async (data) => {
        try {
            const { room_id, peer_id } = JSON.parse(data);
            const room = rooms.get(room_id);

            if (!room) return;

            const player = room.players[peer_id];
            if (player) {
                player.status = PLAYER_STATUS.LEFT;
            }

            socket.leave(room_id);
            socket.currentRoomId = null;

            // Broadcast leave
            socket.to(room_id).emit('leave_room', JSON.stringify(peer_id));

            // console.log(`[LEAVE] Peer ${peer_id} left room ${room_id}`);

            // Check if game should end
            const activeCount = room.players.filter(p =>
                p.status === PLAYER_STATUS.PLAYING
            ).length;

            if (activeCount === 0 || (room.status === GAME_STATUS.WAITING && room.players.length === 0)) {
                clearTurnTimer(room); // Clear timer before deleting room
                rooms.delete(room_id);
                // console.log(`[CLEANUP] Empty room ${room_id} deleted`);
            } else if (activeCount === 1 && room.status === GAME_STATUS.PLAYING) {
                // Only 1 player left, auto win
                clearTurnTimer(room);
                room.status = GAME_STATUS.FINISHED;

                // Find remaining player and mark as winner
                const winner = room.players.find(p => p.status === PLAYER_STATUS.PLAYING);
                if (winner) {
                    winner.status = PLAYER_STATUS.WIN;
                    io.to(room_id).emit('win_game', JSON.stringify(winner.peerId));
                }

                // Send game over with full results
                const results = calculateGameResults(room);
                await updatePlayerCoinsAndStats(room, results);
                io.to(room_id).emit('game_over', JSON.stringify(results));
                console.log(`[GAME_OVER] Players left - Results: ${JSON.stringify(results)}`);
            }

        } catch (error) {
            console.error('[LEAVE_ROOM] Error:', error);
        }
    });

    // ===== CHAT & SOCIAL =====
    socket.on('user_chat', (data) => {
        try {
            const { room_id, peer_id, chat_text } = JSON.parse(data);
            socket.to(room_id).emit('user_chat', JSON.stringify({ peer_id, chat_text }));
        } catch (error) {
            console.error('[CHAT] Error:', error);
        }
    });

    socket.on('user_emoji_id', (data) => {
        try {
            const { room_id, peer_id, emoji_id } = JSON.parse(data);
            socket.to(room_id).emit('user_emoji_id', JSON.stringify({ peer_id, emoji_id }));
        } catch (error) {
            console.error('[EMOJI] Error:', error);
        }
    });

    socket.on('user_send_gift', (data) => {
        try {
            const { room_id, peer_id, gift_id } = JSON.parse(data);
            socket.to(room_id).emit('user_send_gift', JSON.stringify({ peer_id, gift_id }));
        } catch (error) {
            console.error('[GIFT] Error:', error);
        }
    });

    // ===== RECONNECTION - GET PREVIOUS ROOM =====
    socket.on('get_previous_room', (data) => {
        try {
            const { room_id, user_id } = JSON.parse(data);
            const room = rooms.get(room_id);

            if (!room) {
                socket.emit('room_not_found', { message: 'Room not found or expired' });
                return;
            }

            // Find player in room
            const player = room.players.find(p => p.userId === user_id);

            if (!player) {
                socket.emit('room_not_found', { message: 'Player not in room' });
                return;
            }

            // Update socket ID
            player.socketId = socket.id;
            socket.join(room_id);
            socket.currentRoomId = room_id;

            // Send room data
            const roomData = {
                room_id: room.roomId,
                peer_id: player.peerId,
                turn_id: room.currentTurn,
                players: room.players.map(p => ({
                    peer_id: p.peerId,
                    user_id: p.userId,
                    user_name: p.userName,
                    status: p.status
                })),
                game_data: room.gameData
            };

            socket.emit('previous_room_data', JSON.stringify(roomData));
            console.log(`[RECONNECT] ${user_id} reconnected to room ${room_id}`);

        } catch (error) {
            console.error('[GET_PREVIOUS_ROOM] Error:', error);
            socket.emit('room_not_found', { message: 'Failed to reconnect' });
        }
    });

    // ===== REMOVE FROM MATCHMAKING =====
    socket.on('remove_from_matchmaking', (userId) => {
        // Find and remove player from waiting rooms
        for (let [roomId, room] of rooms.entries()) {
            if (room.status === GAME_STATUS.WAITING) {
                const playerIndex = room.players.findIndex(p => p.userId === userId);
                if (playerIndex !== -1) {
                    room.players.splice(playerIndex, 1);
                    socket.leave(roomId);

                    if (room.players.length === 0) {
                        rooms.delete(roomId);
                    }

                    console.log(`[REMOVE_MATCHMAKING] User ${userId} removed from room ${roomId}`);
                    break;
                }
            }
        }
    });

    // ===== DISCONNECT =====
    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] Socket disconnected: ${socket.id}`);

        // Find user's room and handle disconnect
        if (socket.currentRoomId) {
            const room = rooms.get(socket.currentRoomId);
            if (room) {
                const player = room.players.find(p => p.socketId === socket.id);
                if (player) {
                    console.log(`[DISCONNECT] Player ${player.userName} disconnected from room ${room.roomId}`);

                    // Don't immediately remove - allow reconnection
                    // Set timeout for player removal
                    setTimeout(() => {
                        const currentRoom = rooms.get(socket.currentRoomId);
                        if (currentRoom) {
                            const currentPlayer = currentRoom.players.find(p => p.userId === player.userId);
                            if (currentPlayer && currentPlayer.socketId === socket.id) {
                                currentPlayer.status = PLAYER_STATUS.TIMEOUT;
                                socket.to(room.roomId).emit('user_timeout', JSON.stringify(player.peerId));
                            }
                        }
                    }, 30000); // 30 second grace period
                }
            }
        }

        // Clean up user socket mapping
        if (socket.userId) {
            userSockets.delete(socket.userId);
        }
    });
});

// ===== HTTP ENDPOINTS =====
app.get('/', (req, res) => {
    res.send('Ludo Socket.IO Server Running');
});

app.get('/status', (req, res) => {
    res.json({
        status: 'running',
        rooms: rooms.size,
        users: users.size,
        connections: io.sockets.sockets.size
    });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // Bind to all interfaces

server.listen(PORT, HOST, () => {
    console.log(`\n🎮 Ludo Socket.IO Server`);
    console.log(`📡 Server running on ${HOST}:${PORT}`);
    console.log(`🌐 http://localhost:${PORT}`);
    console.log(`🌍 External: http://103.231.190.56:${PORT}\n`);
});

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});
