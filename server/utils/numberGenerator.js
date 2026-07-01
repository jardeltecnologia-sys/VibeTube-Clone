'use strict';

const db = require('../db');

/**
 * Função responsável por criar a string do número de telemóvel brasileiro.
 * Formato: DDD (aleatório válido) + 9 + 8 dígitos aleatórios.
 */
function generateBrazilianNumber() {
    // Lista de DDDs válidos no Brasil
    const validDDDs = [
        11, 19, 21, 27, 31, 41, 47, 51, 61, 71, 81, 85, 91, 92
    ];
    
    // 1. Escolhe um DDD aleatório da lista
    const ddd = validDDDs[Math.floor(Math.random() * validDDDs.length)];
    
    // 2. O prefixo móvel brasileiro
    const mobilePrefix = "9";
    
    // 3. Gera 8 dígitos aleatórios (de 00000000 a 99999999)
    const randomBody = Math.floor(Math.random() * 100000000).toString().padStart(8, '0');
    
    // Retorna a string completa (11 caracteres de puro número)
    return `${ddd}${mobilePrefix}${randomBody}`;
}

/**
 * Função para gerar e garantir que o número é ÚNICO no banco de dados.
 * @param {string} userId - O ID do utilizador que receberá o número.
 * @returns {string} O novo número de celular VibeTube.
 */
function assignUniqueVirtualNumber(userId) {
    const maxAttempts = 12; // Proteção contra loop infinito
    const checkStmt = db.prepare('SELECT 1 FROM users WHERE virtual_number = ?');
    const updateStmt = db.prepare('UPDATE users SET virtual_number = ? WHERE id = ?');

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const newNumber = generateBrazilianNumber();

        // Pré-checagem rápida (evita a maioria das colisões).
        if (checkStmt.get(newNumber)) continue;

        try {
            // A gravação em si é a garantia real: a coluna virtual_number é
            // UNIQUE, então numa corrida (dois cadastros no mesmo instante) o
            // segundo UPDATE dispara erro de UNIQUE e nós tentamos outro número.
            updateStmt.run(newNumber, userId);
            console.log(`[VibeTube] Número virtual +55 ${newNumber} atribuído ao utilizador ${userId}`);
            return newNumber;
        } catch (err) {
            const msg = String(err && err.message || '');
            if (/UNIQUE|constraint/i.test(msg)) continue; // colidiu na corrida — tenta de novo
            throw err; // erro real (ex.: usuário inexistente) — propaga
        }
    }

    // Se por um milagre falhar todas as tentativas.
    throw new Error('Falha ao gerar um número virtual único após várias tentativas.');
}

module.exports = {
    generateBrazilianNumber,
    assignUniqueVirtualNumber
};
