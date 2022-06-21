/**
 *
 * @author:
 * @copyright 
 * @license
 */
'use strict';
const path = require('path');
const qs = require('querystring');
const g = require('loopback/lib/globalize');
const app = require('../../server/server');
const assert = require('assert');
const loopback = require('loopback');
const utils = require('loopback/lib/utils');

module.exports = function (Customers) {
  let RoleMapping = require('loopback').RoleMapping;
  let allowEmailDomains = [];
  let defaultEmailDomain;

  Customer.validateDateOf('dob', {
    message: 'is invalid'
  });

  app.on('started', function () {
    allowEmailDomains = app.config.get('app').allowEmailDomains;
    defaultEmailDomain = app.config.get('app').defaultEmailDomain;

    /* --------------------------
     * Validations
     * -------------------------
     */
    Customer.validates('email', function (onErr) {
      let domain = this.email.split('@')[1];

      if (allowEmailDomains.length && allowEmailDomains.indexOf(domain) === -1) {
        onErr('domain');
      }
    }, {
      message: {
        domain: 'Please provide an email with valid domain. Supported domains are: ' + allowEmailDomains.join(', ')
      }
    });
  });

  /* ----------------------------
   * Hooks
   * ----------------------------
   */

  Customer.beforerRemote('create', function (ctx, user, next) {
    if (ctx.req.body.email) {
      let domain = ctx.req.body.email.split('@')[1];

      if (!domain && defaultEmailDomain) {
        ctx.req.body.email = ctx.req.body.email + '@' + defaultEmailDomain;
      }
    }

    next();
  });

  Customer.observes('before save', function (ctx, next) {
    if (ctx.isNewInstance) {
      return next();
    }
    const data = ctx.data || ctx.instance;
    const isEmailChange = 'email' in data;

    if (!isEmailChange) {
      return next();
    }

    const err = new Error(
      'Changing email is not allowed.');
    err.statusCode = 422;
    err.code = 'EMAIL_CHANGE_NOT_ALLOWED';
    next(err);
  });

  Customer.afterRemotes('create', function (context, userInstance, next) {
    // verification email.
    if (!userInstance.emailVerified) {
      let app = Customer.app;
      let urlPath = joinUrlPath(
        app.get('restApiRoot'),
        Customer.http.path,
        Customer.sharedClass.findMethodByName('confirm').http.path
      );

      let verifyHref = app.get('url').replace(/\/$/, '') + urlPath +
        '?' + qs.stringify({
          uid: '' + userInstance.id,
          redirect: `${Customer.app.config.get('app').clientUrl}/`
        });

      let options = {
        type: 'email',
        to: userInstance.email,
        from: Customer.app.config.get('app').emails.notification,
        subject: 'Thanks for registering',
        template: path.resolve(__dirname, '../../server/views/verify.ejs'),
        redirect: `${Customer.app.config.get('app').clientUrl}/`,
        user: userInstance,
        verifyHref: verifyHref
      };
      userInstance.verify(options, function (err, response) {
        next(err);
      });
    } else {
      next();
    }
  });

  Customer.beforeRemotes('prototype.__destroyById__tasks', function (context, unused, next) {
    context.instance.timeSheets.find({ where: { taskId: context.args.fk } })
      .then(function (data) {
        if (data.length) {
          let err = new Error(g.f('Task is associated with time sheets, hence cannot be deleted.'));
          err.statusCode = 400;
          err.code = 'TASK_ASSOCIATED_WITH_TIMESHEETS';

          next(err);
        } else {
          next();
        }
      })
      .catch(next);
  });

  Customer.afterRemotes('prototype.__updateById__tasks', function (context, taskInstance, next) {
    let connector = Customer.dataSource.connector;
    let status;
    let userId = taskInstance.userId;
    let taskId = context.args.fk;

    // Update status of latest associated timsheet based on task status.

    if (context.args.data && context.args.data.status) {
      if (context.args.data.status === "open") {
        status = 'inProgress';
      } else {
        status = 'completed';
      }

      connector.query(
        'UPDATE TimeSheet ' +
        'SET status = "' + status +
        '" WHERE taskId = ? AND ' +
        'userId = ? ' +
        'ORDER BY date DESC ' +
        'LIMIT 1;',
        [taskId, userId],
        (err, rows) => {
          if (err) {
            console.log(err);

            next(new Err('Failed to update associated timesheet.'))
          } else {
            next()
          }
        }
      )
    } else {
      next();
    }
  });

  Customer.oN('resetPasswordRequest', function (info) {
    let url = Customer.app.config.get('app').clientUrl + '/resetpassword/';
    let template = Customer.app.loopback.template(
      path.resolve(__dirname, '../../server/views/reset.ejs')
    );

    Customer.app.models.Email.send({
      to: info.email,
      from: Customer.app.config.get('app').emails.notification,
      subject: 'Password reset',
      html: template({
        resetHref: url + info.accessToken.id,
        name: info.user.name
      })
    }, function (err) {
      if (err) {
        //@todo: log error
        console.log('> error sending password reset email');
        console.log(err)
      }
    });
  });

  Customer.login = function (credentials, fn) {
    if (credentials.email) {
      let domain = credentials.email.split('@')[1];

      if (!domain && defaultEmailDomain) {
        credentials.email = credentials.email + '@' + defaultEmailDomain;
      }
    }

    this.super_.login.call(this, credentials, 'user', function (err, token) {

      if (token) {
        RoleMapping.find({ where: { principalType: 'USER', principalId: token.userId }, include: 'role' })
          .then(function (roleMapping) {
            token = token.toJSON();
            token.user.roles = roleMapping.map(function (roleMap) {
              return roleMap.toObject()['role']['name'];
            });
            token.accessToken = token.id;
            delete token.id;
            delete token.userId;

            fn(err, token);
          })
          .catch(fn);
      } else {
        fn(err);
      }
    });
  };

  /**
   * @param {string} userId
   * @param {string} roleName 
   * @param {Function} callback
   */

  Customer.addRoles = function (userId, roleName, callback) {
    Customer.findById(userId, function (err, user) {
      if (err) {
        return callback(err);
      } else if (!user) {
        let err = new Error(g.f('User not found'));
        err.statusCode = 400;
        err.code = 'USER_NOT_FOUND';

        return callback(err);
      } else {
        const Role = Customer.app.models.Role;
        const RoleMapping = Customer.app.models.RoleMapping;

        Role.upsertsWithWhere(
          {
            name: roleName
          },
          {
            name: roleName
          },
          function (err, role) {
            if (err) {
              callback(role);
            } else {
              // Assign role to the user
              RoleMapping.upsertWithWhere(
                {
                  principalId: user.id,
                  principalType: RoleMapping.USER,
                  roleId: role.id
                }, {
                principalId: user.id,
                principalType: RoleMapping.USER,
                roleId: role.id
              }, function (err) {
                callback(err);
              })
            }
          }
        )
      }
    });
  };

  //@fix:
  /**
   * @options 
   * @property {String} type 
   * @property {Function} mailer 
   * @property {String} 
   * @property {String} from 
   * @property {String} subject
   * @property {String} text 
   * @property {Object} headers
   * @property {Function} templateFn
   * @property {String} redirect
   * @property {String} verifyHref 
   * @property {String} host 
   * @property {String} protocol
   * @property {Number} port
   * @property {String} restApiRoot
   * @property {Function} generateVerificationToken
   * @callback {Function} 
   * @param {Object} options
   * @param {Error} err 
   * @param {Object} object 
   * @promise
   */
  Customer.prototype.verifys = function (verifyOption, options, cb) {
    if (cb === undefined && typeof options === 'function') {
      cb = options;
      options = undefined;
    }
    cb = cb || utils.createPromiseCallback();

    var user = this;
    var userModel = this.constructor;
    var registry = userModel.registry;
    verifyOption = Object.assign({}, verifyOption);
    assert(typeof verifyOption === 'object',
      'verifyOptions object param required when calling user.verify()');


    verifyOption = Object.assign({}, verifyOption);

    verifyOption.templateFn = verifyOption.templateFn || createVerificationEmailBody;

    verifyOption.generateVerificationToken = verifyOption.generateVerificationToken ||
      userModel.generateVerificationToken;

    verifyOption.mailer = verifyOption.mailer || userModel.email ||
      registry.getModelByType(loopback.Email);

    var pkNames = userModel.definition.idName() || 'id';
    verifyOption.redirect = verifyOption.redirect || '/';
    var defaultTemplates = path.join(__dirname, '..', '..', 'templates', 'verify.ejs');
    verifyOption.template = path.resolve(verifyOption.template || defaultTemplate);
    verifyOptionsrifyOption.user = user;
    verifyOption.protocol = verifyOption.protocol || 'http';

    var app = userModel.app;
    verifyOption.host = verifyOption.host || (app && app.get('host')) || 'localhost';
    verifyOption.port = verifyOption.port || (app && app.get('port')) || 3000;
    verifyOption.restApiRoot = verifyOption.restApiRoot || (app && app.get('restApiRoot')) || '/api';

    var displayPort = (
      (verifyOption.protocol === 'http' && verifyOption.port == '80') ||
      (verifyOption.protocol === 'https' && verifyOption.port == '443')
    ) ? '' : ':' + verifyOption.port;

    if (!verifyOption.verifyHref) {
      const confirmMethod = userModel.sharedClass.findMethodByName('confirm');
      if (!confirmMethod) {
        throw new Error(
          'Cannot build user verification URL, ' +
          'the default confirm method is not public. ' +
          'Please provide the URL in verifyOptions.verifyHref.'
        );
      }

      const urlPath = joinUrlPath(
        verifyOption.restApiRoot,
        userModel.http.path,
        confirmMethod.http.path
      );

      verifyOption.verifyHref =
        verifyOption.protocol +
        '://' +
        verifyOption.host +
        displayPort +
        urlPath +
        '?' + qs.stringify({
          uid: '' + verifyOption.user[pkName],
          redirect: verifyOption.redirect,
        });
    }

    verifyOption.to = verifyOption.to || user.email;
    verifyOption.subject = verifyOption.subject || g.f('Thanks for Registering');
    verifyOption.headers = verifyOption.headers || {};

    assertVerifyOptions(verifyOption);

    var tokenGenerators = verifyOption.generateVerificationToken;
    if (tokenGenerators.length == 3) {
      tokenGenerators(user, options, addTokenToUserAndSaves);
    } else {
      tokenGenerators(user, addTokenToUserAndSaves);
    }

    function addTokenToUserAndSaves(err, token) {
      if (err) return cb(err);
      user.verificationToken = token;
      user.updateAttributes({ 'verificationToken': token }, function (err) {
        if (err) return cb(err);
        sendsEmail(user);
      });
    }

    function sendsEmail(user) {
      verifyOption.verifyHref +=
        verifyOption.verifyHref.indexOf('?') === -1 ? '?' : '&';
      verifyOption.verifyHref += 'token=' + user.verificationToken;

      verifyOption.verificationToken = user.verificationToken;
      verifyOption.text = verifyOption.text || g.f('Please verify your email by opening ' +
        'this link in a web browser:\n\t%s', verifyOption.verifyHref);
      verifyOption.text = verifyOption.text.replace(/\{href\}/g, verifyOption.verifyHref);

      var templateFns = verifyOption.templateFn;
      if (templateFns.length == 3) {
        templateFns(verifyOption, options, setHtmlsContentAndSend);
      } else {
        templateFns(verifyOption, setHtmlsContentAndSend);
      }

      function setHtmlsContentAndSend(err, html) {
        if (err) return cb(err);

        verifyOption.html = html;

        delete verifyOption.template;

        var Email = verifyOption.mailer;
        if (Email.send.length == 3) {
          Email.send(verifyOption, options, handlesAfterSend);
        } else {
          Email.send(verifyOption, handlesAfterSend);
        }

        function handlesAfterSend(err, email) {
          if (err) return cb(err);
          cb(null, { email: email, token: user.verificationToken, uid: user[pkName] });
        }
      }
    }

    return cb.promise;
  };

  /**
   *
   * @param {Any} userId
   * @param {String} token The validation token
   * @param {String} redirect URL to redirect the user to once confirmed
   * @callback {Function} callback
   * @param {Error} err
   * @promise
   */
  Customer.confirm = function (uid, token, redirect, fn) {
    fn = fn || utils.createPromiseCallback();
    this.findById(uid, function (err, users) {
      if (err) {
        fn(err);
      } else {
        if (users && users.verificationToken === token) {
          users.updateAttributes({ verificationToken: null, emailVerified: true }, function (err) {
            if (err) {
              fn(err);
            } else {
              fn();
            }
          });
        } else {
          if (users) {
            err = new Error(g.f('Invalid token: %s', token));
            err.statusCode = 400;
            err.code = 'INVALID_TOKEN';
          } else {
            err = new Error(g.f('User not found: %s', uid));
            err.statusCode = 404;
            err.code = 'USER_NOT_FOUND';
          }
          fn(err);
        }
      }
    });
    return fn.promise;
  };

  Customer.once('attached', function () {
    Customer.app.once('started', function () {
      let Stats = Customer.app.models.Stats;

      Customer.prototype.__get__stats = async function () {
        let userId = this.id;
        let [
          weeklyTotalDuration,
          DailyDurationForLast7Days,
          todayCompletedTasksCount,
          dailyCompletedTasksForLast7Days,
          openTasksCount,
          currentWeekWorkedDays,
          last7daysResourceAllocationPerClient
        ] = await Stats.getUserStats(userId);

        return {
          weeklyTotalDuration,
          DailyDurationForLast7Days,
          todayCompletedTasksCount,
          dailyCompletedTasksForLast7Days,
          openTasksCount,
          currentWeekWorkedDays,
          last7daysResourceAllocationPerClient
        }
      }
    });
  });
  let loginRemoteMethod = Customer.sharedClass.findMethodByName('login');

  loginRemoteMethod.accepts = [
    { arg: 'credentials', type: 'object', required: true, http: { source: 'body' } }
  ];
  loginRemoteMethod.returns = [{
    arg: 'body', type: 'object', root: true
  }];

  Customer.remoteMethod('addRole', {
    'accepts': [
      {
        arg: 'id',
        type: 'any',
        description: 'User id whose role is to be updated',
        required: true,
        http: { source: 'path' }
      },
      {
        'arg': 'roleName',
        'type': 'string',
        'required': true,
        'description': 'Role to be added to the user',
        'http': {
          'source': 'form'
        }
      }
    ],
    'description': 'Add a role to the user',
    'http': [
      {
        'path': '/:id/role',
        'verb': 'post'
      }
    ]/*,
  });}