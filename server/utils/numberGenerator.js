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
    let isUnique = false;
    let newNumber = '';
    let attempts = 0;
    const maxAttempts = 10; // Proteção contra loop infinito

    // Loop de validação de unicidade
    while (!isUnique && attempts < maxAttempts) {
        newNumber = generateBrazilianNumber();
        
        // Verifica no banco de dados se alguém já tem este número
        const stmt = db.prepare('SELECT id FROM users WHERE virtual_number = ?');
        const existingUser = stmt.get(newNumber);
        
        // Se não encontrar nenhum utilizador, o número é único!
        if (!existingUser) {
            isUnique = true;
        }
        attempts++;
    }

    // Se por um milagre falhar 10 vezes
    if (!isUnique) {
        throw new Error('Falha ao gerar um número virtual único após várias tentativas.');
    }

    // Guarda o número no banco de dados associado a este utilizador
    const updateStmt = db.prepare('UPDATE users SET virtual_number = ? WHERE id = ?');
    updateStmt.run(newNumber, userId);

    console.log(`[VibeTube] Número virtual +55 ${newNumber} atribuído ao utilizador ${userId}`);
    
    return newNumber;
}

module.exports = {
    generateBrazilianNumber,
    assignUniqueVirtualNumber
};
