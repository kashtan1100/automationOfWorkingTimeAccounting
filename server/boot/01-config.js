
'use strict';
const path = require('path');
const NodejsConfig = require('nodejs-config');

module.exports = (app) => {
  app.config = NodejsConfig(
    path.resolve('.'),
    () => {
      return process.env.NODE_ENV;
    }
  );
};
