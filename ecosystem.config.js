'use strict';

module.exports = {
  apps: [
    {
      name: 'speedvox-app',
      script: './server/index.js',
      instances: process.env.PM2_INSTANCES || 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
