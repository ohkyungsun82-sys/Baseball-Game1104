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
    if (!username || !password) return res.json({ success: false, message: '아이디와 비밀번호를 입력해주세요.' });
    const db = loadDB();
    if (db.users.find(u => u.username === username)) return res.json({ success: false, message: '이미 존재하는 아이디입니다.' });
    db.users.push({ username, password, wins: 0, losses: 0, gamesPlayed: 0 });
    saveDB(db);
    res.json({ success: true, user: { username, wins: 0, losses: 0, gamesPlayed: 0 } });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.username === username && u.password === password);
    if (!user) return res.json({ success: false, message: '아이디 또는 비밀번호가 틀렸습니다.' });
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

            // 실제 야구 게임 상태 초기화
            rooms[roomName] = {
                players: [p1, p2],
                inning: 1,
                isTop: true, // true: p1이 초(공격), false: p2가 초(공격)
                scores: { [p1.id]: 0, [p2.id]: 0 },
                outs: 0,
                strikes: 0,
                balls: 0,
                bases: [false, false, false], // 1루, 2루, 3루
                batter: p1,
                pitcher: p2
            };

            p1.emit('game_start', { opponent: p2.username, role: 'batter', gameState: rooms[roomName] });
            p2.emit('game_start', { opponent: p1.username, role: 'pitcher', gameState: rooms[roomName] });
        }
    });

    socket.on('cancel_matchmaking', () => {
        if (waitingPlayer === socket) waitingPlayer = null;
    });

    // 투수가 구종 선택 후 공 던지기
    function switchRoles(room) {
        const temp = room.batter;
        room.batter = room.pitcher;
        room.pitcher = temp;
    }

    function checkInningChange(room, roomName) {
        if (room.outs >= 3) {
            room.outs = 0;
            room.strikes = 0;
            room.balls = 0;
            room.bases = [false, false, false];

            if (room.isTop) {
                room.isTop = false; // 말 공격으로 전환
            } else {
                room.isTop = true;
                room.inning++; // 다음 이닝
            }

            if (room.inning > 3) { // 3이닝 경기로 설정 (원하면 9이닝으로 변경 가능)
                io.to(roomName).emit('game_over', { scores: room.scores });
                delete rooms[roomName];
                return true;
            } else {
                switchRoles(room);
            }
        }
        return false;
    }

    socket.on('pitch_ball', ({ pitchType }) => {
        let roomName = null;
        for (let r in rooms) { if (rooms[r].players.includes(socket)) { roomName = r; break; } }
        if (!roomName) return;
        const room = rooms[roomName];
        if (room.pitcher !== socket) return;

        // 타자에게 공이 날아감 통보
        room.batter.emit('incoming_pitch', { pitchType });
    });

    // 타자의 타격 결과 처리
    socket.on('atbat_result', ({ result, hitPower }) => { // result: 'homerun', 'hit', 'strike', 'ball', 'out'
        let roomName = null;
        for (let r in rooms) { if (rooms[r].players.includes(socket)) { roomName = r; break; } }
        if (!roomName) return;
        const room = rooms[roomName];
        if (room.batter !== socket) return;

        let batterId = room.batter.id;

        if (result === 'homerun') {
            let count = 1 + room.bases.filter(b => b).length;
            room.scores[batterId] += count;
            room.bases = [false, false, false];
        } else if (result === 'hit') {
            // 진루 계산
            if (room.bases[2]) { room.scores[batterId]++; }
            room.bases[2] = room.bases[1];
            room.bases[1] = room.bases[0];
            room.bases[0] = true;
        } else if (result === 'strike') {
            room.strikes++;
            if (room.strikes >= 3) {
                room.outs++;
                room.strikes = 0;
                room.balls = 0;
            }
        } else if (result === 'ball') {
            room.balls++;
            if (room.balls >= 4) {
                // 볼넷 진루
                if (room.bases[0] && room.bases[1] && room.bases[2]) {
                    room.scores[batterId]++;
                } else {
                    if (room.bases[0] && room.bases[1]) room.bases[2] = true;
                    if (room.bases[0]) room.bases[1] = true;
                    room.bases[0] = true;
                }
                room.balls = 0;
            }
        } else if (result === 'out') {
            room.outs++;
            room.strikes = 0;
            room.balls = 0;
        }

        const isOver = checkInningChange(room, roomName);
        if (!isOver) {
            io.to(roomName).emit('update_game_state', { gameState: room });
        }
    });

    socket.on('send_chat', (message) => {
        for (let r in rooms) {
            if (rooms[r].players.includes(socket)) {
                io.to(r).emit('receive_chat', { sender: socket.username, message });
                break;
            }
        }
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
server.listen(PORT, () => { console.log(`서버 실행 중: http://localhost:${PORT}`); });
