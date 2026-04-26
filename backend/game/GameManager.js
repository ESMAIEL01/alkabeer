class GameManager {
    constructor(io, db) {
        this.io = io;
        this.db = db;
        this.lobbies = new Map(); 
        this.userSocketMap = new Map();

        this.io.on('connection', (socket) => {
            console.log('Client connected:', socket.id);

            socket.on('disconnect', () => {
                this.handleDisconnect(socket);
            });

            socket.on('authenticate', (data) => {
                const { token, user } = data;
                if (user && user.id) {
                    this.userSocketMap.set(user.id, socket.id);
                    socket.userId = user.id;
                    socket.username = user.username;
                }
            });

            socket.on('create_room', (data, callback) => {
                const roomId = this.generateRoomId();
                const mode = data.mode || 'HUMAN'; // HUMAN | AI
                
                this.lobbies.set(roomId, {
                    id: roomId,
                    creatorId: socket.userId,
                    hostId: mode === 'HUMAN' ? socket.userId : 'AI_HOST',
                    mode: mode,
                    players: new Map(),
                    state: 'LOBBY', 
                    gameData: null
                });
                
                this.joinRoom(socket, roomId, mode === 'HUMAN');
                callback({ success: true, roomId });
            });

            socket.on('join_room', (data, callback) => {
                const { roomId } = data;
                if (!this.lobbies.has(roomId)) {
                    return callback({ success: false, message: 'Room not found' });
                }
                const isHost = this.lobbies.get(roomId).hostId === socket.userId;
                this.joinRoom(socket, roomId, isHost);
                callback({ success: true, roomId });
            });
            
            socket.on('get_game_state', (data) => {
                const { roomId } = data;
                socket.currentRoom = roomId;
                const lobby = this.lobbies.get(roomId);
                if(lobby) {
                     socket.emit('full_state_update', {
                          phase: lobby.gameData?.phase || 'LOBBY',
                          timer: lobby.gameData?.timer || 0,
                          archive: lobby.gameData?.archiveBase64 || '',
                          currentClue: lobby.gameData?.clues?.[lobby.gameData.clueIndex] || '',
                          hostId: lobby.hostId,
                          players: Array.from(lobby.players.values()).map(p => ({
                              id: p.id, username: p.username, isAlive: p.isAlive, isHost: p.isHost
                          }))
                     });
                }
            });

            socket.on('start_game_setup', (data) => {
                const { roomId } = data;
                const lobby = this.lobbies.get(roomId);
                if(lobby && (lobby.hostId === socket.userId || lobby.mode === 'AI')) {
                    this.io.to(roomId).emit('game_started', { id: roomId });
                }
            });

            // For Human host finalizing custom architecture
            socket.on('finalize_archive', (data) => {
                const { archive, raw, clues } = data;
                const roomId = socket.currentRoom;
                if(!roomId) return;
                
                const lobby = this.lobbies.get(roomId);
                if(lobby && (lobby.hostId === socket.userId || (lobby.mode === 'AI' && lobby.creatorId === socket.userId))) {
                    lobby.state = 'IN_GAME';
                    lobby.gameData = {
                        archiveBase64: archive,
                        rawScenario: raw,
                        clues: clues || ["دليل 1...", "دليل 2...", "دليل 3..."],
                        clueIndex: 0,
                        phase: 'ARCHIVE_LOCKED',
                        timer: 15, // give 15s lock time before clue 1
                        interval: null,
                        isPaused: false,
                        votes: {}
                    };
                    
                    this.broadcastFullState(roomId);
                    this.startRoomTimer(roomId);
                }
            });
            
            // For voting
            socket.on('submit_vote', (data) => {
               const { roomId, targetId } = data;
               const lobby = this.lobbies.get(roomId);
               if(lobby && lobby.gameData && lobby.gameData.phase === 'VOTING') {
                   lobby.gameData.votes[socket.userId] = targetId;
                   socket.emit('vote_registered', { userId: socket.userId, targetId });
               }
            });

            socket.on('host_control', (data) => {
                const { action, roomId } = data;
                const lobby = this.lobbies.get(roomId);
                if(lobby && lobby.hostId === socket.userId && lobby.gameData) {
                    if(action === 'pause') lobby.gameData.isPaused = true;
                    else if (action === 'resume') lobby.gameData.isPaused = false;
                    else if (action === 'extend') lobby.gameData.timer += 30;
                    else if (action === 'skip') lobby.gameData.timer = 0; 
                    
                    this.io.to(roomId).emit('timer_update', lobby.gameData.timer);
                }
            });
            
            socket.on('force_phase', (data) => {
                 const { phase, roomId } = data;
                 const lobby = this.lobbies.get(roomId);
                 if(lobby && lobby.hostId === socket.userId && lobby.gameData) {
                     lobby.gameData.phase = phase;
                     lobby.gameData.timer = 60;
                     if(phase === 'CLUE_REVEAL' && lobby.gameData.clueIndex < 2) {
                         lobby.gameData.clueIndex++;
                     }
                     this.broadcastFullState(roomId);
                 }
            });
        });
    }

    startRoomTimer(roomId) {
        const lobby = this.lobbies.get(roomId);
        if(!lobby || !lobby.gameData) return;
        if(lobby.gameData.interval) clearInterval(lobby.gameData.interval);

        lobby.gameData.interval = setInterval(() => {
            if(!lobby.gameData.isPaused) {
                lobby.gameData.timer -= 1;
                this.io.to(roomId).emit('timer_update', Math.max(0, lobby.gameData.timer));

                if(lobby.gameData.timer <= 0) {
                    this.handlePhaseEnd(roomId);
                }
            }
        }, 1000);
    }
    
    broadcastFullState(roomId) {
        const lobby = this.lobbies.get(roomId);
        if(!lobby) return;
        this.io.to(roomId).emit('full_state_update', {
              phase: lobby.gameData?.phase || 'LOBBY',
              timer: lobby.gameData?.timer || 0,
              archive: lobby.gameData?.archiveBase64 || '',
              currentClue: lobby.gameData?.clues?.[lobby.gameData.clueIndex] || '',
              hostId: lobby.hostId,
              players: Array.from(lobby.players.values()).map(p => ({
                  id: p.id, username: p.username, isAlive: p.isAlive, isHost: p.isHost
              }))
        });
    }

    handlePhaseEnd(roomId) {
        const lobby = this.lobbies.get(roomId);
        if(!lobby || !lobby.gameData) return;
        
        let shouldContinue = true;

        if(lobby.gameData.phase === 'ARCHIVE_LOCKED') {
            lobby.gameData.phase = 'CLUE_REVEAL';
            lobby.gameData.timer = 45; 
        } else if (lobby.gameData.phase === 'CLUE_REVEAL') {
            lobby.gameData.phase = 'VOTING';
            lobby.gameData.timer = 30; 
        } else if (lobby.gameData.phase === 'VOTING') {
            // After voting, we either go back to clues or game over
            if (lobby.gameData.clueIndex < 2) {
                lobby.gameData.clueIndex++;
                lobby.gameData.phase = 'CLUE_REVEAL';
                lobby.gameData.timer = 45;
                // clear votes
                lobby.gameData.votes = {};
            } else {
                lobby.gameData.phase = 'POST_GAME';
                lobby.gameData.timer = 0;
                shouldContinue = false;
            }
        }
        
        this.broadcastFullState(roomId);
        
        if (!shouldContinue && lobby.gameData.interval) {
             clearInterval(lobby.gameData.interval);
        }
    }

    generateRoomId() {
        return Math.random().toString(36).substring(2, 8).toUpperCase();
    }

    joinRoom(socket, roomId, isHost = false) {
        socket.join(roomId);
        const lobby = this.lobbies.get(roomId);
        if(!lobby) return;
        
        // Don't add AI as a distinct user obj
        if(isHost && lobby.mode === 'AI') return;

        lobby.players.set(socket.userId, {
            id: socket.userId,
            username: socket.username,
            socketId: socket.id,
            isHost: isHost,
            isAlive: true,
            role: null,
        });

        socket.currentRoom = roomId;
        this.io.to(roomId).emit('room_update', this.getRoomPublicData(roomId));
    }

    handleDisconnect(socket) {
        if (socket.currentRoom) {
            const lobby = this.lobbies.get(socket.currentRoom);
            if(lobby && lobby.players.has(socket.userId)) {
                // leave them inside for state reconnection
            }
        }
    }

    getRoomPublicData(roomId) {
        const lobby = this.lobbies.get(roomId);
        if (!lobby) return null;

        const playersArr = Array.from(lobby.players.values()).map(p => ({
            id: p.id, username: p.username, isHost: p.isHost, isAlive: p.isAlive
        }));

        return { id: lobby.id, state: lobby.state, players: playersArr, mode: lobby.mode, creatorId: lobby.creatorId };
    }
}

module.exports = GameManager;
