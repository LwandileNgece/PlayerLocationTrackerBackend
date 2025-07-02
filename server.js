// server.js - Real-time Location Tracking Server
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Configure CORS and Socket.io
const io = socketIo(server, {
    cors: {
        origin: ["https://player-location-tracker-frontend-r5gbsf6s4.vercel.app/"],
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
});

// Middleware
app.use(cors({
    origin: "*",
    credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// In-memory storage for active players
const activePlayers = new Map();
const playerSockets = new Map(); // Track socket IDs

// Utility functions
function generatePlayerName() {
    const adjectives = ['Swift', 'Brave', 'Clever', 'Quick', 'Bold', 'Smart', 'Fast', 'Cool', 'Mighty', 'Sharp'];
    const nouns = ['Explorer', 'Ranger', 'Scout', 'Traveler', 'Navigator', 'Wanderer', 'Adventurer', 'Hunter', 'Seeker', 'Roamer'];
    return adjectives[Math.floor(Math.random() * adjectives.length)] + 
           nouns[Math.floor(Math.random() * nouns.length)] + 
           Math.floor(Math.random() * 1000);
}

function validateLocation(lat, lng) {
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    
    return !isNaN(latitude) && 
           !isNaN(longitude) && 
           latitude >= -90 && 
           latitude <= 90 && 
           longitude >= -180 && 
           longitude <= 180;
}

// Clean up inactive players every 60 seconds
setInterval(() => {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes timeout
    
    for (const [playerId, player] of activePlayers) {
        if (now - player.lastSeen > timeout) {
            activePlayers.delete(playerId);
            playerSockets.delete(playerId);
            
            // Notify all clients about player leaving
            io.emit('playerLeft', {
                playerId: playerId,
                reason: 'timeout'
            });
            
            console.log(`🔴 Player ${player.name} (${playerId}) timed out and was removed`);
        }
    }
    
    console.log(`📊 Active players: ${activePlayers.size}`);
}, 60000);

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`🔗 New client connected: ${socket.id}`);
    
    // Send welcome message and current players
    socket.emit('connected', {
        message: 'Connected to location tracker server',
        timestamp: new Date().toISOString(),
        activePlayers: activePlayers.size
    });
    
    // Send current players to new client (without exposing exact locations for privacy)
    const sanitizedPlayers = Array.from(activePlayers.values()).map(player => ({
        id: player.id,
        name: player.name,
        hasLocation: !!(player.lat && player.lng),
        lastSeen: player.lastSeen,
        isActive: (Date.now() - player.lastSeen) < 60000
    }));
    
    socket.emit('playersOnline', sanitizedPlayers);
    
    // Handle player joining
    socket.on('playerJoin', (playerData) => {
        try {
            const playerId = playerData.id || `player_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            const playerName = playerData.name || generatePlayerName();
            
            const player = {
                id: playerId,
                name: playerName,
                socketId: socket.id,
                joinedAt: Date.now(),
                lastSeen: Date.now(),
                lat: null,
                lng: null,
                isTracking: false
            };
            
            activePlayers.set(playerId, player);
            playerSockets.set(playerId, socket.id);
            
            // Notify all clients about new player
            io.emit('playerJoined', {
                id: player.id,
                name: player.name,
                hasLocation: false,
                isActive: true,
                lastSeen: player.lastSeen
            });
            
            // Send player their assigned ID
            socket.emit('playerAssigned', {
                id: playerId,
                name: playerName
            });
            
            console.log(`🟢 Player joined: ${playerName} (${playerId})`);
            
        } catch (error) {
            console.error('❌ Error handling player join:', error);
            socket.emit('error', { message: 'Failed to join game' });
        }
    });
    
    // Handle location updates
    socket.on('locationUpdate', (data) => {
        try {
            const { playerId, lat, lng, timestamp } = data;
            
            if (!playerId || !validateLocation(lat, lng)) {
                socket.emit('error', { message: 'Invalid location data' });
                return;
            }
            
            const player = activePlayers.get(playerId);
            if (!player || player.socketId !== socket.id) {
                socket.emit('error', { message: 'Player not found or unauthorized' });
                return;
            }
            
            // Update player location
            player.lat = parseFloat(lat);
            player.lng = parseFloat(lng);
            player.lastSeen = Date.now();
            player.isTracking = true;
            
            activePlayers.set(playerId, player);
            
            // Broadcast location update to all other clients
            socket.broadcast.emit('locationUpdate', {
                id: player.id,
                name: player.name,
                lat: player.lat,
                lng: player.lng,
                timestamp: player.lastSeen,
                isActive: true
            });
            
            // Confirm update to sender
            socket.emit('locationConfirmed', {
                timestamp: player.lastSeen
            });
            
            console.log(`📍 Location update: ${player.name} at ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
            
        } catch (error) {
            console.error('❌ Error processing location update:', error);
            socket.emit('error', { message: 'Failed to update location' });
        }
    });
    
    // Handle player stopping tracking
    socket.on('stopTracking', (playerId) => {
        try {
            const player = activePlayers.get(playerId);
            if (player && player.socketId === socket.id) {
                player.isTracking = false;
                player.lastSeen = Date.now();
                activePlayers.set(playerId, player);
                
                // Notify all clients
                io.emit('playerStoppedTracking', {
                    id: playerId,
                    name: player.name
                });
                
                console.log(`⏹️ Player ${player.name} stopped tracking`);
            }
        } catch (error) {
            console.error('❌ Error handling stop tracking:', error);
        }
    });
    
    // Handle player leaving explicitly
    socket.on('playerLeave', (playerId) => {
        handlePlayerDisconnect(socket.id, playerId, 'left');
    });
    
    // Handle ping for connection testing
    socket.on('ping', (data, callback) => {
        const pong = {
            timestamp: Date.now(),
            activePlayers: activePlayers.size,
            ...data
        };
        
        if (callback && typeof callback === 'function') {
            callback(pong);
        } else {
            socket.emit('pong', pong);
        }
    });
    
    // Handle disconnection
    socket.on('disconnect', (reason) => {
        console.log(`🔌 Client disconnected: ${socket.id}, reason: ${reason}`);
        handlePlayerDisconnect(socket.id, null, reason);
    });
    
    // Handle errors
    socket.on('error', (error) => {
        console.error(`🚨 Socket error from ${socket.id}:`, error);
    });
});

// Helper function to handle player disconnection
function handlePlayerDisconnect(socketId, playerId, reason) {
    try {
        let disconnectedPlayer = null;
        
        if (playerId) {
            disconnectedPlayer = activePlayers.get(playerId);
        } else {
            // Find player by socket ID
            for (const [id, player] of activePlayers) {
                if (player.socketId === socketId) {
                    disconnectedPlayer = player;
                    playerId = id;
                    break;
                }
            }
        }
        
        if (disconnectedPlayer) {
            activePlayers.delete(playerId);
            playerSockets.delete(playerId);
            
            // Notify all clients about player leaving
            io.emit('playerLeft', {
                playerId: playerId,
                playerName: disconnectedPlayer.name,
                reason: reason
            });
            
            console.log(`🔴 Player ${disconnectedPlayer.name} (${playerId}) disconnected: ${reason}`);
        }
    } catch (error) {
        console.error('❌ Error handling player disconnect:', error);
    }
}

// REST API endpoints
app.get('/', (req, res) => {
    res.json({
        message: 'Location Tracker Server',
        status: 'running',
        timestamp: new Date().toISOString(),
        stats: {
            activePlayers: activePlayers.size,
            connectedSockets: io.engine.clientsCount,
            uptime: process.uptime()
        },
        endpoints: {
            health: '/health',
            stats: '/stats',
            players: '/players'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        server: {
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            version: process.version
        },
        game: {
            activePlayers: activePlayers.size,
            connectedSockets: io.engine.clientsCount
        }
    });
});

app.get('/stats', (req, res) => {
    const now = Date.now();
    const playersStats = Array.from(activePlayers.values()).map(player => ({
        id: player.id,
        name: player.name,
        isTracking: player.isTracking,
        lastSeen: player.lastSeen,
        timeAgo: now - player.lastSeen,
        isActive: (now - player.lastSeen) < 60000
    }));
    
    res.json({
        server: {
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            memory: process.memoryUsage()
        },
        connections: {
            socketClients: io.engine.clientsCount,
            activePlayers: activePlayers.size
        },
        players: playersStats
    });
});

app.get('/players', (req, res) => {
    const now = Date.now();
    const players = Array.from(activePlayers.values()).map(player => ({
        id: player.id,
        name: player.name,
        isTracking: player.isTracking,
        lastSeen: player.lastSeen,
        isActive: (now - player.lastSeen) < 60000,
        // Don't expose exact coordinates for privacy
        hasLocation: !!(player.lat && player.lng)
    }));
    
    res.json({
        count: players.length,
        timestamp: new Date().toISOString(),
        players: players
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Express error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        message: `Route ${req.method} ${req.path} not found`,
        timestamp: new Date().toISOString()
    });
});

// Start server
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log('🚀 =================================');
    console.log(`📍 Location Tracker Server Started`);
    console.log(`🌐 Server: http://${HOST}:${PORT}`);
    console.log(`⚡ Socket.io: Ready for connections`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log('🚀 =================================');
});

// Graceful shutdown
const shutdown = (signal) => {
    console.log(`\n🛑 ${signal} received, shutting down gracefully...`);
    
    // Notify all connected clients
    io.emit('serverShutdown', {
        message: 'Server is shutting down',
        timestamp: new Date().toISOString()
    });
    
    server.close((err) => {
        if (err) {
            console.error('❌ Error during shutdown:', err);
            process.exit(1);
        }
        console.log('✅ Server shut down successfully');
        process.exit(0);
    });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle unhandled errors
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});