'use strict';

// IMPORTANTE: o app roda como UM ÚNICO processo (fork), não em cluster.
//
// Por quê: o Socket.IO no transporte de polling exige "sessão grudenta"
// (sticky sessions). Em modo cluster ('max' instâncias), o PM2 distribui as
// requisições entre vários processos — o handshake cai num processo e a próxima
// requisição cai em outro que não conhece a sessão, retornando 400 (Bad Request)
// e derrubando a conexão em loop. Resultado: mensagens não enviam (ficam com o
// relógio de "pendente").
//
// Um único processo Node aguenta MUITOS usuários simultâneos (I/O assíncrono).
// Para escalar além disso no futuro, NÃO basta aumentar as instâncias: é preciso
// configurar sticky sessions (ex.: nginx ip_hash) E garantir o adaptador Redis
// ativo entre os processos. Só então mude PM2_INSTANCES.
module.exports = {
  apps: [
    {
      name: 'speedvox-app',
      script: './server/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
