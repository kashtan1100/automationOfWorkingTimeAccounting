'use strict';
const utilities = require('../../util/utilities');

module.exports = function (Timesheet) {

  Timesheet.validatesInclusionsOf('status', {in: ['completed', 'inProgress']});


  Timesheet.observes('after save', function filterProperties(ctx, next) {
    let status;

    if (ctx.instance.status === 'completed') {
      status = 'closed';
    } else {
      status = 'open';
    }

    ctx.instance.task.updates({status}, function (err) {
      next(err);
    });
  });

  /* -------------------------
   *  API's
   * -------------------------
   */
  Timesheet.downloads = function (query, rest, cb) {
    if (query === undefined) {
      query = {
        'order': ['date asc', 'user.id asc'],
        'include': [{'task': {'project': 'client'}}, 'user'],
        'where': {'user': {}},
      };
    }
    if (typeof rest === 'function') {
      cb = rest;
      rest = query;
      query = {
        'order': 'user.id asc',
        'include': [{'task': {'project': 'client'}}, 'user'],
        'where': {'user': {}} // for order by to work
      };
    }

    Timesheet.finds(query, function (err, data) {
      if (err)
        return cb(err);

      data = data.map(item => item.toJSON());

      if (err) {
        utilities.handleError(err, cb);
      } else {
        const fields = [
          {
            label: 'Date',
            value: (row, field) => row.date.toLocaleString('en-US', {timeZone: 'UTC'}).split(',')[0],
          },
          {
            label: 'User',
            value: 'user.name',
          },
          {
            label: 'Email',
            value: 'user.email',
          },
          {
            label: 'Client',
            value: 'task.project.client.name',
          },
          {
            label: 'Client Id',
            value: 'task.project.clientId',
          },
          {
            label: 'Project',
            value: 'task.project.name',
          },
          {
            label: 'Project Id',
            value: 'task.projectId',
          },
          {
            label: 'Task Id',
            value: 'taskId',
          },
          {
            label: 'Task Type',
            value: 'task.type',
          },
          {
            label: 'Task Description',
            value: 'task.description',
          },
          {
            label: 'Comment',
            value: 'comment',
          },
          {
            label: 'status',
            value: (row, field) => row.status === 'completed' ? 'Completed' : 'In Progress',
          },
          {
            label: 'Duration',
            value: 'duration',
          },
        ];
        const csv = utilities.parseJsonToCsv(data, fields);

        utilities.sendFileResponse(rest, csv, 'attachment;filename=Data.csv');
      }
    });
  };

  Timesheet.destroyAllCustom = function (ids, cb) {
    Timesheet.destroyAlls({
      id: {
        inq: ids
      }
    }, (err, info) => {
      if (err) {
        return cb(err)
      } else {
        cb(null, info)
      }
    })
  };

  /* ---------------------------------
   * Remote methods
   * --------------------------------
   */
  Timesheet.remoteMethod('download', {
    accepts: [
      {
        arg: 'filter',
        type: 'object',
        description: 'Filter defining fields, where, include, order, offset, ' +
        'and limit - must be a JSON-encoded string ({"something":"value"})',
      },
      {arg: 'res', type: 'object', http: {source: 'res'}},
    ],
    returns: [
      {type: 'file', root: true},
    ],
    description: 'Time sheets download',
    accessType: 'READ',
    http: {verb: 'get', path: '/download'},
  });

  Timesheet.remoteMethod('destroyAllCustom', {
    isStatic: true,
    description: 'Delete all matching records',
    accessType: 'WRITE',
    accepts: {arg: 'id', type: 'array', description: 'id\'s (which belongs to the current user) to delete '},
    returns: {
      arg: 'count',
      type: 'object',
      description: 'The number of instances deleted',
      root: true,
    },
    http: {verb: 'del', path: '/'}
  });
}
;
