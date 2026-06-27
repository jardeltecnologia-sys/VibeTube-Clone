'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth-middleware');
const { now, id } = require('../util');
const { isMember } = require('../chat-service');
const { getIo } = require('../bus');

const router = express.Router();
router.use(requireAuth);

// GET /api/chats/:id/tasks - List all tasks for this chat.
router.get('/:id/tasks', (req, res) => {
  const chatId = req.params.id;
  if (!isMember(chatId, req.user.id)) return res.status(403).json({ error: 'forbidden' });

  const tasks = db
    .prepare('SELECT * FROM chat_tasks WHERE chat_id = ? ORDER BY created_at DESC')
    .all(chatId);

  res.json({ tasks });
});

// POST /api/chats/:id/tasks - Create a new task.
router.post('/:id/tasks', (req, res) => {
  const chatId = req.params.id;
  if (!isMember(chatId, req.user.id)) return res.status(403).json({ error: 'forbidden' });

  const { title, messageId, assigneeId, dueDate } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Título é obrigatório' });

  const taskId = id();
  db.prepare(
    `INSERT INTO chat_tasks (id, chat_id, message_id, title, assignee_id, due_date, completed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    taskId,
    chatId,
    messageId || null,
    title.trim(),
    assigneeId || null,
    dueDate ? Number(dueDate) : null,
    now()
  );

  const task = db.prepare('SELECT * FROM chat_tasks WHERE id = ?').get(taskId);
  
  const io = getIo();
  if (io) {
    io.to(`chat:${chatId}`).emit('task:new', { chatId, task });
  }

  res.json({ ok: true, task });
});

// PATCH /api/chats/:id/tasks/:taskId - Update/toggle a task.
router.patch('/:id/tasks/:taskId', (req, res) => {
  const { id: chatId, taskId } = req.params;
  if (!isMember(chatId, req.user.id)) return res.status(403).json({ error: 'forbidden' });

  const task = db.prepare('SELECT * FROM chat_tasks WHERE id = ? AND chat_id = ?').get(taskId, chatId);
  if (!task) return res.status(404).json({ error: 'Tarefa não encontrada' });

  const { title, assigneeId, dueDate, completed } = req.body || {};

  const newTitle = title !== undefined ? title.trim() : task.title;
  const newAssignee = assigneeId !== undefined ? assigneeId : task.assignee_id;
  const newDueDate = dueDate !== undefined ? (dueDate ? Number(dueDate) : null) : task.due_date;
  const newCompleted = completed !== undefined ? (completed ? 1 : 0) : task.completed;

  db.prepare(
    `UPDATE chat_tasks SET title = ?, assignee_id = ?, due_date = ?, completed = ?
     WHERE id = ? AND chat_id = ?`
  ).run(newTitle, newAssignee, newDueDate, newCompleted, taskId, chatId);

  const updatedTask = db.prepare('SELECT * FROM chat_tasks WHERE id = ?').get(taskId);

  const io = getIo();
  if (io) {
    io.to(`chat:${chatId}`).emit('task:updated', { chatId, task: updatedTask });
  }

  res.json({ ok: true, task: updatedTask });
});

module.exports = router;
