const express = require('express');
const usersRouter = require('./routes/users');

const app = express();

app.use('/api', usersRouter);

app.get('/health', (req, res) => res.json({ ok: true }));

module.exports = app;
