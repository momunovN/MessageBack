const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

const User = require('./models/User');
const Message = require('./models/Message');
const Request = require('./models/Request');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ msg: 'Нет токена' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ msg: 'Неверный токен' });
    req.user = user;
    next();
  });
};

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password) return res.status(400).json({ msg: 'Заполните поля' });

  try {
    if (await User.findOne({ username: username.trim() })) {
      return res.status(400).json({ msg: 'Логин уже занят' });
    }
    const user = new User({ username: username.trim(), password });
    await user.save();
    res.status(201).json({ msg: 'Регистрация успешна' });
  } catch (err) {
    console.error('Register error:', err);
    if (err.code === 11000) return res.status(400).json({ msg: 'Логин уже занят' });
    res.status(500).json({ msg: 'Ошибка сервера' });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ username: username?.trim() });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(400).json({ msg: 'Неверный логин или пароль' });
    }
    const token = jwt.sign({ username: user.username }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ msg: 'Ошибка сервера' });
  }
});

app.get('/users', authenticateToken, async (req, res) => {
  try {
    const users = await User.find({}, 'username friends -_id');
    res.json(users);
  } catch (err) {
    res.status(500).json({ msg: 'Ошибка загрузки пользователей' });
  }
});

app.put('/profile', authenticateToken, async (req, res) => {
  const { newUsername, newPassword } = req.body;
  const currentUsername = req.user.username;

  try {
    const user = await User.findOne({ username: currentUsername });
    if (!user) return res.status(404).json({ msg: 'Пользователь не найден' });

    if (newUsername && newUsername.trim() !== currentUsername) {
      if (await User.findOne({ username: newUsername.trim() })) {
        return res.status(400).json({ msg: 'Этот логин уже занят' });
      }
      user.username = newUsername.trim();
    }

    if (newPassword && newPassword.length >= 4) {
      user.password = newPassword;
    } else if (newPassword) {
      return res.status(400).json({ msg: 'Пароль слишком короткий' });
    }

    await user.save();

    const newToken = jwt.sign({ username: user.username }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ msg: 'Профиль обновлён', token: newToken });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ msg: 'Ошибка при обновлении профиля' });
  }
});

// Запрос на ЛС
app.post('/requests', authenticateToken, async (req, res) => {
  const { to } = req.body;
  const from = req.user.username;

  if (from === to) return res.status(400).json({ msg: 'Нельзя отправить запрос себе' });

  try {
    const existing = await Request.findOne({ from, to });
    if (existing) return res.status(400).json({ msg: 'Запрос уже отправлен' });

    const request = new Request({ from, to });
    await request.save();

    io.to(to).emit('new_request', request);

    res.status(201).json({ msg: 'Запрос отправлен' });
  } catch (err) {
    res.status(500).json({ msg: 'Ошибка' });
  }
});

// Получить запросы для пользователя
app.get('/requests', authenticateToken, async (req, res) => {
  try {
    const requests = await Request.find({ to: req.user.username, status: 'pending' });
    res.json(requests);
  } catch (err) {
    res.status(500).json({ msg: 'Ошибка' });
  }
});

// Одобрить/отклонить запрос
app.put('/requests/:id', authenticateToken, async (req, res) => {
  const { status } = req.body; // accepted or rejected
  try {
    const request = await Request.findById(req.params.id);
    if (!request || request.to !== req.user.username) return res.status(404).json({ msg: 'Запрос не найден' });

    request.status = status;
    await request.save();

    if (status === 'accepted') {
      await User.updateOne({ username: request.to }, { $addToSet: { friends: request.from } });
      await User.updateOne({ username: request.from }, { $addToSet: { friends: request.to } });
      io.to(request.from).emit('request_accepted', { from: request.to });
    }

    res.json({ msg: 'Запрос обновлён' });
  } catch (err) {
    res.status(500).json({ msg: 'Ошибка' });
  }
});

// Сообщения
app.post('/messages', authenticateToken, async (req, res) => {
  const { text, to = 'global', type = 'text', data } = req.body;
  const from = req.user.username;

  if (type === 'text' && !text?.trim()) return res.status(400).json({ msg: 'Сообщение пустое' });
  if ((type === 'image' || type === 'voice') && !data) return res.status(400).json({ msg: 'Нет данных' });

  if (to !== 'global') {
    const user = await User.findOne({ username: from });
    if (!user.friends.includes(to)) return res.status(403).json({ msg: 'Нет одобрения для ЛС' });
  }

  try {
    const message = new Message({
      from,
      to,
      type,
      text: text?.trim(),
      data
    });
    await message.save();

    const roomName = to === 'global' ? 'global' : [from, to].sort().join('_');
    io.to(roomName).emit('message', message);

    // Уведомление получателю, если он онлайн
    if (to !== 'global') {
      io.to(to).emit('notification', { from, type: message.type });
    }

    res.status(201).json(message);
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ msg: 'Ошибка отправки' });
  }
});

app.post('/messages', authenticateToken, async (req, res) => {
  const { text, to = 'global' } = req.body;
  const from = req.user.username;

  if (!text?.trim()) return res.status(400).json({ msg: 'Сообщение пустое' });

  if (to !== 'global') {
    const user = await User.findOne({ username: from });
    if (!user.friends.includes(to)) return res.status(403).json({ msg: 'Нет одобрения для ЛС' });
  }

  try {
    const message = new Message({ from, to, text: text.trim() });
    await message.save();

    const roomName = to === 'global' ? 'global' : [from, to].sort().join('_');
    io.to(roomName).emit('message', message);

    res.status(201).json(message);
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ msg: 'Ошибка отправки' });
  }
});

// Socket.io с онлайн-статусом
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Нет токена'));
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return next(new Error('Неверный токен'));
    socket.user = user;
    next();
  });
});

const onlineUsers = new Set();

io.on('connection', (socket) => {
  const username = socket.user.username;
  console.log('Подключился:', username);

  onlineUsers.add(username);
  io.emit('online_users', Array.from(onlineUsers));

  socket.join('global');
  socket.join(username);

  socket.on('disconnect', () => {
    onlineUsers.delete(username);
    io.emit('online_users', Array.from(onlineUsers));
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});