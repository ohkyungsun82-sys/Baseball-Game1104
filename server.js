const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const DB_FILE = path.join(__dirname, 'database.json');

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ users: [] }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

app.post('/api/signup', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.json({ success: false, message: '아이디와 비밀번호를 입력해주세요.' });
    }
    const db = loadDB();
    if (db.users.find(u => u.username === username)) {
        return res.json({ success: false, message: '이미 존재하는 아이디입니다.' });
    }
    const newUser = { username, password, wins: 0, losses: 0, gamesPlayed: 0 };
    db.users.push(newUser);
    saveDB(db);
    res.json({ success: true, user: { username, wins: 0, losses: 0, gamesPlayed: 0 } });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.username === username && u.password === password);
    if (!user) {
        return res.json({ success: false, message: '아이디 또는 비밀번호가 틀렸습니다.' });
    }
    res.json({ success: true, user: { username: user.username, wins: user.wins, losses: user.losses, gamesPlayed: user.gamesPlayed } });
});

let waitingPlayer = null;
const rooms = {};

io.on('connection', (socket) => {
    socket.on('join_matchmaking', (username) => {
        socket.username = username;
        if (!waitingPlayer) {
            waitingPlayer = socket;
            socket.emit('waiting', '상대를 찾는 중입니다...');
        } else {
            const p1 = waitingPlayer;
            const p2 = socket;
            waitingPlayer = null;

            const roomName = 'room_' + Date.now();
            p1.join(roomName);
            p2.join(roomName);

            rooms[roomName] = {
                players: [p1, p2],
                scores: { [p1.id]: 0, [p2.id]: 0 },
                turn: p1.id
            };

            p1.emit('game_start', { opponent: p2.username, isMyTurn: true });
            p2.emit('game_start', { opponent: p1.username, isMyTurn: false });
        }
    });

    socket.on('cancel_matchmaking', () => {
        if (waitingPlayer === socket) waitingPlayer = null;
    });

    socket.on('send_chat', (message) => {
        for (let r in rooms) {
            if (rooms[r].players.includes(socket)) {
                io.to(r).emit('receive_chat', { sender: socket.username, message });
                break;
            }
        }
    });

    socket.on('submit_score', ({ score }) => {
        let roomName = null;
        for (let r in rooms) {
            if (rooms[r].players.includes(socket)) {
                roomName = r;
                break;
            }
        }
        if (!roomName) return;
        const room = rooms[roomName];
        room.scores[socket.id] = score;

        const opponent = room.players.find(p => p.id !== socket.id);
        
        // 양쪽 다 점수를 제출했거나 턴이 끝났을 때 승패 판정
        // 간단하게 본인의 턴 플레이가 끝나면 상대방에게 점수 전달 및 턴 교체
        io.to(roomName).emit('update_score', { username: socket.username, score });
        
        room.turn = opponent.id;
        io.to(roomName).emit('change_turn', { currentTurn: room.turn });
    });

    socket.on('disconnect', () => {
        if (waitingPlayer === socket) waitingPlayer = null;
        for (let r in rooms) {
            const room = rooms[r];
            if (room.players.includes(socket)) {
                const opponent = room.players.find(p => p.id !== socket.id);
                if (opponent) opponent.emit('opponent_disconnected');
                delete rooms[r];
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`서버 실행 중: http://localhost:${PORT}`);
});
