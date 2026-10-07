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
    console.log('사용자 접속:', socket.id);

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

            const generateSecret = () => {
                const nums = [1,2,3,4,5,6,7,8,9];
                const secret = [];
                for (let i = 0; i < 3; i++) {
                    const idx = Math.floor(Math.random() * nums.length);
                    secret.push(nums.splice(idx, 1)[0]);
                }
                return secret.join('');
            };

            rooms[roomName] = {
                players: [p1, p2],
                secrets: { [p1.id]: generateSecret(), [p2.id]: generateSecret() },
                turn: p1.id,
                history: { [p1.id]: [], [p2.id]: [] }
            };

            p1.emit('game_start', { opponent: p2.username, myTurn: true });
            p2.emit('game_start', { opponent: p1.username, myTurn: false });
        }
    });

    socket.on('cancel_matchmaking', () => {
        if (waitingPlayer === socket) {
            waitingPlayer = null;
        }
    });

    // 게임 내 실시간 채팅 메시지 처리
    socket.on('send_chat', (message) => {
        let roomName = null;
        for (let r in rooms) {
            if (rooms[r].players.includes(socket)) {
                roomName = r;
                break;
            }
        }
        if (roomName) {
            io.to(roomName).emit('receive_chat', { sender: socket.username, message });
        }
    });

    socket.on('submit_guess', ({ guess }) => {
        let roomName = null;
        for (let r in rooms) {
            if (rooms[r].players.includes(socket)) {
                roomName = r;
                break;
            }
        }
        if (!roomName) return;

        const room = rooms[roomName];
        if (room.turn !== socket.id) return;

        const opponent = room.players.find(p => p.id !== socket.id);
        const secret = room.secrets[opponent.id];

        let strikes = 0;
        let balls = 0;
        for (let i = 0; i < 3; i++) {
            if (guess[i] === secret[i]) {
                strikes++;
            } else if (secret.includes(guess[i])) {
                balls++;
            }
        }

        const resultText = strikes === 0 && balls === 0 ? 'OUT' : `${strikes}S ${balls}B`;
        const logEntry = { guess, result: resultText };
        room.history[socket.id].push(logEntry);

        io.to(roomName).emit('turn_result', {
            attacker: socket.username,
            guess,
            strikes,
            balls,
            history: room.history
        });

        if (strikes === 3) {
            socket.emit('game_over', { won: true });
            opponent.emit('game_over', { won: false });
            
            const db = loadDB();
            const u1 = db.users.find(u => u.username === socket.username);
            const u2 = db.users.find(u => u.username === opponent.username);
            if (u1) { u1.wins++; u1.gamesPlayed++; }
            if (u2) { u2.losses++; u2.gamesPlayed++; }
            saveDB(db);

            delete rooms[roomName];
            return;
        }

        room.turn = opponent.id;
        io.to(roomName).emit('change_turn', { currentTurn: room.turn });
    });

    socket.on('disconnect', () => {
        if (waitingPlayer === socket) waitingPlayer = null;
        for (let r in rooms) {
            const room = rooms[r];
            if (room.players.includes(socket)) {
                const opponent = room.players.find(p => p.id !== socket.id);
                if (opponent) {
                    opponent.emit('opponent_disconnected');
                }
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