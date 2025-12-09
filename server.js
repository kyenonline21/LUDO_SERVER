const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Trong production nên set specific domain
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

// ===== IN-MEMORY STORAGE (Thay bằng database trong production) =====
const users = new Map(); // userId -> userData
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
    room.turnTimer = setTimeout(() => {
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
                console.log(`[TIMEOUT] Player ${currentPlayer.userName} marked as timeout`);
            }

            // Auto change turn
            const nextTurn = getNextTurn(room);
            if (nextTurn !== -1) {
                room.currentTurn = nextTurn;
                const nextPlayer = room.players[nextTurn];
                io.to(room.roomId).emit('turn_changed', JSON.stringify(nextPlayer.peerId));
                console.log(`[AUTO_TURN_CHANGE] Room ${room.roomId}, Next turn: Peer ${nextPlayer.peerId}`);

                // Start timer for next turn
                startTurnTimer(room);
            } else {
                // No active players - game over
                io.to(room.roomId).emit('game_over', JSON.stringify({ reason: 'All players timeout' }));
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

// ===== SOCKET.IO CONNECTION =====
io.on('connection', (socket) => {
    console.log(`[CONNECT] Socket connected: ${socket.id}`);

    // ===== USER AUTHENTICATION =====
    socket.on('add_user', (data) => {
        try {
            const { user_id, user_name, fcm_token } = JSON.parse(data);

            // Store user data
            users.set(user_id, {
                userId: user_id,
                userName: user_name,
                fcmToken: fcm_token,
                coins: 1000, // Default coins
                level: 1,
                winCount: 0,
                lostCount: 0
            });

            userSockets.set(user_id, socket.id);
            socket.userId = user_id;

            // Generate auth token (in production, use JWT)
            const authToken = `token_${user_id}_${Date.now()}`;

            socket.emit('auth_token', authToken);
            console.log(`[ADD_USER] User added: ${user_name} (${user_id})`);

        } catch (error) {
            console.error('[ADD_USER] Error:', error);
            socket.emit('error', { message: 'Failed to add user' });
        }
    });

    // ===== GET USER DATA =====
    socket.on('get_userdata', (data) => {
        try {
            const { user_id } = JSON.parse(data);
            const user = users.get(user_id);

            if (user) {
                socket.emit('user_data', JSON.stringify(user));
            } else {
                socket.emit('error', { message: 'User not found' });
            }
        } catch (error) {
            console.error('[GET_USERDATA] Error:', error);
        }
    });

    // ===== MATCHMAKING - REQUEST JOIN ROOM =====
    socket.on('request_join', (data) => {
        try {
            const jsonData = JSON.parse(data);
            const user_id = jsonData.user_id;
            const user_name = jsonData.user_name;
            const bet_amount = jsonData.room_coin_value; // Client sends "room_coin_value"
            const player_count = jsonData.room_players_size; // Client sends "room_players_size"

            console.log(`[REQUEST_JOIN] ${user_name} looking for ${player_count}P room with bet ${bet_amount}`);

            // Find available room
            let room = findAvailableRoom(bet_amount, player_count);

            // Create new room if none available
            if (!room) {
                const roomId = uuidv4();
                room = createRoom(roomId, user_id, bet_amount, player_count);
                rooms.set(roomId, room);
                console.log(`[CREATE_ROOM] New room created: ${roomId}`);
            }

            // Add player to room
            const player = createPlayer(user_id, user_name, room.players.length, socket.id);
            room.players.push(player);

            // Join socket room
            socket.join(room.roomId);
            socket.currentRoomId = room.roomId;

            console.log(`[PLAYER_JOINED] ${user_name} joined room ${room.roomId} as peer ${player.peerId}`);

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
                console.log(`[GAME_START] Room ${room.roomId} started with ${room.players.length} players`);

                // Start turn timer for first player
                startTurnTimer(room);
            }

        } catch (error) {
            console.error('[REQUEST_JOIN] Error:', error);
            socket.emit('error', { message: 'Failed to join room' });
        }
    });

    // ===== FRIEND ROOM - CREATE =====
    socket.on('friend_create_room', (data) => {
        try {
            const jsonData = JSON.parse(data);
            const user_id = jsonData.user_id;
            const user_name = jsonData.user_name;
            const bet_amount = jsonData.room_coin_value; // Client sends "room_coin_value"
            const player_count = jsonData.room_players_size; // Client sends "room_players_size"
            const room_code = jsonData.room_code;

            const roomId = room_code || uuidv4().substring(0, 6).toUpperCase();
            const room = createRoom(roomId, user_id, bet_amount, player_count);
            rooms.set(roomId, room);

            const player = createPlayer(user_id, user_name, 0, socket.id);
            room.players.push(player);

            socket.join(roomId);
            socket.currentRoomId = roomId;

            socket.emit('friend_room_code', JSON.stringify({ room_code: roomId }));
            console.log(`[FRIEND_CREATE] Room created: ${roomId} by ${user_name}`);

        } catch (error) {
            console.error('[FRIEND_CREATE] Error:', error);
            socket.emit('friend_error_response', { message: 'Failed to create room' });
        }
    });

    // ===== FRIEND ROOM - JOIN =====
    socket.on('friend_join_room', (data) => {
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

            console.log(`[FRIEND_JOIN] ${user_name} joined room ${room_code}`);

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

            console.log(`[DICE] Room ${room_id}, Peer ${peer_id} rolled ${dice_face}`);

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

            // Broadcast token reset
            io.to(room_id).emit('token_recieved', JSON.stringify({
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

            console.log(`[TURN_CHANGE] Room ${room_id}, Turn changed to peer ${currentPlayer.peerId}`);

            // Start timer for next turn
            startTurnTimer(room);

        } catch (error) {
            console.error('[CHANGE_TURN] Error:', error);
        }
    });

    // ===== GAME ACTIONS - WIN =====
    socket.on('win_game', (data) => {
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

                // Calculate results and emit game over
                const results = room.players.map(p => ({
                    peer_id: p.peerId,
                    user_id: p.userId,
                    user_name: p.userName,
                    status: p.status
                }));

                io.to(room_id).emit('game_over', JSON.stringify({ results }));
                console.log(`[GAME_OVER] Room ${room_id} finished`);

                // Clean up room after delay
                setTimeout(() => {
                    rooms.delete(room_id);
                    console.log(`[CLEANUP] Room ${room_id} deleted`);
                }, 10000);
            }

        } catch (error) {
            console.error('[WIN_GAME] Error:', error);
        }
    });

    // ===== GAME ACTIONS - LEAVE ROOM =====
    socket.on('leave_room', (data) => {
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

            console.log(`[LEAVE] Peer ${peer_id} left room ${room_id}`);

            // Check if game should end
            const activeCount = room.players.filter(p =>
                p.status === PLAYER_STATUS.PLAYING
            ).length;

            if (activeCount === 0 || (room.status === GAME_STATUS.WAITING && room.players.length === 0)) {
                clearTurnTimer(room); // Clear timer before deleting room
                rooms.delete(room_id);
                console.log(`[CLEANUP] Empty room ${room_id} deleted`);
            } else if (activeCount === 1 && room.status === GAME_STATUS.PLAYING) {
                // Only 1 player left, end game
                clearTurnTimer(room);
                room.status = GAME_STATUS.FINISHED;
                io.to(room_id).emit('game_over', JSON.stringify({ reason: 'Players left' }));
            }

        } catch (error) {
            console.error('[LEAVE_ROOM] Error:', error);
        }
    });

    // ===== CHAT & SOCIAL =====
    socket.on('user_chat', (data) => {
        try {
            const { room_id, peer_id, message } = JSON.parse(data);
            socket.to(room_id).emit('user_chat', JSON.stringify({ peer_id, message }));
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
