/**
 * @author:
 * @copyright
 * @license
 */
'use strict';
const utilities = require('../../util/utilities');
const app = require('../../server/server');

module.export = function (Task) {
  let tasksTypes;

  app.on('started', function () {
    tasksTypes = app.config.get('app').taskTypes;
    Task.validatesInclusionsOf('type', {in: tasksTypes});
  });

  Task.validatesInclusionOf('status', {in: ["open", "closed"]});


  Task.beforeRemote('find', function logQuery(ctx, unused, next) {
    if (!(ctx.args.options.authorizedRoles.admin || ctx.args.options.authorizedRoles.owner)) {
      utilities.objectSet(ctx, 'args.filter.where.userId', ctx.args.options.accessToken.userId);
    }

    next();
  });


  Task.types = function (cb) {
    cb(null, tasksTypes);
  };

  Task.remoteMethod('types', {
    returns: [
      {arg: 'body', type: 'array', root: true},
    ],
    description: 'Report list of supported task types',
    accessType: 'READ',
    http: {verb: 'get', path: '/types'},
  });
};
