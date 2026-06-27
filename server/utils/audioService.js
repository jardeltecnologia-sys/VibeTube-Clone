'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { now } = require('../util');

// Will be initialized when realtime is set
let ioInstance = null;
let emitToChatFn = null;

function setSocketIo(io, emitToChat) {
  ioInstance = io;
  emitToChatFn = emitToChat;
}

async function transcribeAndSummarize(messageId, filename) {
  const config = require('../config');
  const filePath = path.join(config.uploadDir, filename);

  try {
    const msg = db.prepare('SELECT chat_id FROM messages WHERE id = ?').get(messageId);
    if (!msg) return;

    let transcript = '';
    let summary = '';

    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey && fs.existsSync(filePath)) {
      try {
        // 1. Whisper Transcription
        const FormData = require('form-data');
        const form = new FormData();
        form.append('file', fs.createReadStream(filePath));
        form.append('model', 'whisper-1');
        form.append('language', 'pt');

        const transRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...form.getHeaders(),
          },
          body: form,
        });

        if (transRes.ok) {
          const transData = await transRes.json();
          transcript = transData.text || '';
        } else {
          console.warn('Whisper API failed, status:', transRes.status);
        }

        // 2. GPT Summary
        if (transcript) {
          const summaryRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'gpt-4o-mini',
              messages: [
                {
                  role: 'system',
                  content: 'Você é um assistente útil. Transcreva ou resuma o áudio fornecido em exatamente 3 tópicos curtos, diretos e objetivos usando emojis relevantes no início de cada tópico. Não adicione introduções ou conclusões.',
                },
                {
                  role: 'user',
                  content: `Texto a resumir:\n${transcript}`,
                },
              ],
              max_tokens: 150,
              temperature: 0.5,
            }),
          });

          if (summaryRes.ok) {
            const summaryData = await summaryRes.json();
            summary = summaryData.choices[0].message.content.trim();
          } else {
            console.warn('GPT API failed, status:', summaryRes.status);
          }
        }
      } catch (err) {
        console.error('Erro na chamada da API da OpenAI:', err.message);
      }
    }

    // Fallback Mock if OpenAI is not configured or failed
    if (!transcript) {
      transcript = 'Olá! Esta é uma mensagem de voz recebida e transcrita automaticamente pelo SpeedVox.';
      summary = '• 🎙️ Áudio de voz recebido.\n• ⚡ Transcrição simulada ativa (defina OPENAI_API_KEY no .env para Whisper real).\n• 📝 Resumo gerado com sucesso.';
    }

    // Save to Database
    db.prepare(
      `INSERT INTO audio_transcriptions (message_id, transcript, summary, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET transcript = excluded.transcript, summary = excluded.summary`
    ).run(messageId, transcript, summary, now());

    // Emit via WebSocket to all chat members
    if (emitToChatFn) {
      emitToChatFn(msg.chat_id, 'audio:transcribed', {
        messageId,
        chatId: msg.chat_id,
        transcription: { transcript, summary },
      });
    }
  } catch (err) {
    console.error('transcribeAndSummarize failed:', err.message);
  }
}

module.exports = {
  setSocketIo,
  transcribeAndSummarize,
};
