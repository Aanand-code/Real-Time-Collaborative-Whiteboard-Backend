const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('WebSocket server running...');
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Server started and running on port ${port}`);
});

app.use(express.json());
// CORS Configuration
app.use(
  cors({
    origin: [
      'https://aanand-code.github.io/',
      'https://real-time-collaborative-whiteboard-uove.onrender.com/',
      'http://localhost:5500',
    ],
  })
);

// WebSocket Server
const wss = new WebSocket.Server({
  server,
  verifyClient: (info, done) => {
    const allowedOrigins = [
      'https://aanand-code.github.io/',
      'https://real-time-collaborative-whiteboard-uove.onrender.com/',
      'http://localhost:5500',
    ];

    if (allowedOrigins.includes(info.origin)) {
      return done(true);
    }
    console.log('Rejected connection from origin:', info.origin);
    return done(false, 401, 'Unauthorized origin');
  },
});

// Room management data structures
const rooms = new Map(); // { roomId: Set<ws> }
const users = new Map(); // { roomId: Set<username> }
const drawings = new Map(); // { roomId: Array<drawingData> }

wss.on('connection', (ws) => {
  console.log('New connection established');

  let currentRoom;
  let usernameServer;

  // Handle WebSocket messages
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (!data.type) {
        throw new Error('Missing message type');
      }

      switch (data.type) {
        case 'create_room':
          if (currentRoom) {
            leaveRoom(ws, currentRoom, usernameServer);
          }

          if (data.roomId && data.username) {
            currentRoom = data.roomId;
            usernameServer = data.username;
          }

          handleCreateRoom(ws, currentRoom, usernameServer);
          break;

        case 'join_room':
          if (currentRoom) {
            leaveRoom(ws, currentRoom, usernameServer);
          }
          if (data.roomId && data.username) {
            currentRoom = data.roomId;
            usernameServer = data.username;
          }

          handleJoinRoom(ws, currentRoom, usernameServer);
          break;

        case 'chat':
          currentRoom = data.roomId;
          // Broadcast chat message to other users
          broadcastToRoomExcept(currentRoom, ws, {
            type: 'chat',
            username: usernameServer,
            text: data.text,
            timestamp: Date.now(),
          });
          break;

        case 'start':
        case 'draw':
          currentRoom = data.roomId;
          handleDrawing(ws, data, currentRoom);
          break;

        case 'text':
        case 'rectangle':
        case 'circle':
        case 'clear':
          currentRoom = data.roomId;
          handleShape(ws, data, currentRoom);
          break;

        default:
          console.warn(`Unknown message type: ${data.type}`);
      }
    } catch (error) {
      console.error(`Error handling message: ${error.message}`);
      try {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Invalid data format',
          })
        );
      } catch (sendError) {
        console.error('Failed to send error message:', sendError);
      }
    }
  });

  // Handle connection close
  ws.on('close', () => {
    if (currentRoom) {
      leaveRoom(ws, currentRoom, usernameServer);
    }
    console.log('Connection closed');
  });
});

// Room management functions
function handleCreateRoom(ws, currentRoom, usernameServer) {
  if (!currentRoom || !usernameServer) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'Missing room ID or username',
      })
    );
    return;
  }

  // Create new room if it doesn't exist
  if (!rooms.has(currentRoom)) {
    rooms.set(currentRoom, new Set());
    users.set(currentRoom, new Set());
    drawings.set(currentRoom, []);
    addUserToRoom(ws, currentRoom, usernameServer);
  } else {
    ws.send(
      JSON.stringify({
        type: 'room_already_exist',
        roomId: currentRoom,
        msg: `${currentRoom} already existed...`,
      })
    );
  }
}

function handleJoinRoom(ws, currentRoom, usernameServer) {
  if (!currentRoom || !usernameServer) {
    ws.send(
      JSON.stringify({
        type: 'error',
        msg: 'Missing room ID or username',
      })
    );
    return;
  }

  // Check if room exists
  if (!rooms.has(currentRoom)) {
    ws.send(
      JSON.stringify({
        type: 'no_room',
        msg: `Room ${currentRoom} does not exist`,
      })
    );
    return;
  }

  addUserToRoom(ws, currentRoom, usernameServer);
}

function addUserToRoom(ws, currentRoom, usernameServer) {
  // Add to room
  const roomWs = rooms.get(currentRoom);
  roomWs.add(ws);

  // Add to users
  const roomUsers = users.get(currentRoom);
  roomUsers.add(usernameServer);

  // Notify other users in the room
  broadcastToRoom(currentRoom, {
    type: 'user_joined',
    drawings: drawings.get(currentRoom),
    users: Array.from(roomUsers),
    username: usernameServer,
    roomId: currentRoom,
    userCount: roomWs.size,
    message: `${usernameServer} joined the room: ${currentRoom}`,
  });

  console.log(`${usernameServer} joined room ${currentRoom}`);
}

function leaveRoom(ws, currentRoom, usernameServer) {
  if (!rooms.has(currentRoom)) return;
  if (rooms.has(currentRoom) && users.has(currentRoom)) {
    const roomWs = rooms.get(currentRoom);
    const roomUsers = users.get(currentRoom);
    roomWs.delete(ws);
    roomUsers.delete(usernameServer);
    console.log(`${usernameServer} left room ${currentRoom}`);

    if (roomWs.size === 0 && roomUsers.size === 0) {
      rooms.delete(currentRoom);
      users.delete(currentRoom);
      drawings.delete(currentRoom);
      console.log(`Room ${currentRoom} deleted (no users left)`);
    } else {
      broadcastToRoomExcept(currentRoom, ws, {
        type: 'user_left',
        users: Array.from(roomUsers),
        username: usernameServer,
        roomId: currentRoom,
        userCount: roomWs.size,
        message: `${usernameServer} left the room`,
      });
      console.log(`${usernameServer} left room ${currentRoom}`);
    }
  }
}

// Drawing functions
function handleDrawing(ws, data, currentRoom) {
  if (!drawings.has(currentRoom)) return;

  const drawing = drawings.get(currentRoom);

  if (data.type) {
    drawing.push(data);
  }
  // Broadcast drawing to other users in the room
  broadcastToRoomExcept(currentRoom, ws, data);
}

function handleShape(ws, data, currentRoom) {
  if (!drawings.has(currentRoom)) return;

  const drawing = drawings.get(currentRoom);

  // Store finalized shapes
  if (data.type !== 'clear') {
    drawing.push(data);
  }
  // Handle clear canvas
  else {
    drawings.set(currentRoom, []);
  }

  // Broadcast to other users in the room
  broadcastToRoomExcept(currentRoom, ws, data);
}

// Broadcasting functions
function broadcastToRoom(currentRoom, data) {
  if (!rooms.has(currentRoom)) return;

  const roomWs = rooms.get(currentRoom);
  const dataStr = JSON.stringify(data);

  roomWs.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(dataStr);
    }
  });
}

function broadcastToRoomExcept(currentRoom, excludeWs, data) {
  if (!rooms.has(currentRoom)) return;

  const roomWs = rooms.get(currentRoom);
  const dataStr = JSON.stringify(data);

  roomWs.forEach((client) => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(dataStr);
    }
  });
}

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});
