/*!
 * OS.js - JavaScript Cloud/Web Desktop Platform
 *
 * Copyright (c) 2011-2017, Anders Evenrud <andersevenrud@gmail.com>
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS 'AS IS' AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * @author  Anders Evenrud <andersevenrud@gmail.com>
 * @licence Simplified BSD License
 */
/*eslint strict:["error", "global"]*/
'use strict';

/**
 * @namespace core.instance
 */

/**
 * An object with information about the current environment
 * @property  {String}      [dist=dist]     Which dist to use
 * @property  {Number}      [port=AUTO]     Which port to start on
 * @property  {String}      [AUTH]          Authentication module name
 * @property  {String}      [STORAGE]       Storage module name
 * @property  {String}      [SESSION]       Session module name
 * @typedef ServerOptions
 */

/**
 * An object with information about the current environment
 * @property  {String}        DIST        The dist environment name
 * @property  {Number}        PORT        Current port
 * @property  {Number}        LOGLEVEL    Current loglevel
 * @property  {String}        ROOTDIR     Root directory of OS.js
 * @property  {String}        MODULEDIR   Directory of server modules
 * @property  {String}        SERVERDIR   Directory of the server root
 * @property  {String}        NODEDIR     Directory of the node server
 * @property  {String}        PKGDIR      Directory of packages
 * @typedef ServerEnvironment
 */

const _child = require('child_process');
const _fs = require('fs-extra');
const _path = require('path');
const _glob = require('glob-promise');

const _osjs = {
  http: require('./http.js'),
  logger: require('./logger.js'),
  auth: require('./auth.js'),
  vfs: require('./vfs.js'),
  utils: require('./utils.js')
};

///////////////////////////////////////////////////////////////////////////////
// GLOBALS
///////////////////////////////////////////////////////////////////////////////

let CHILDREN = [];
let CONFIG = {};
let PACKAGES = {};
let LOGGER;

const MODULES = {
  API: {},
  VFS: [],
  MIDDLEWARE: [],
  SESSION: null,
  AUTH: null,
  STORAGE: null,
  LOGGER: null
};

const ENV = {
  PORT: null,
  DIST: 'dist',
  LOGLEVEL: -2,
  NODEDIR: _path.resolve(__dirname + '/../'),
  ROOTDIR: _path.resolve(__dirname + '/../../../../'),
  MODULEDIR: _path.resolve(__dirname + '/../modules'),
  SERVERDIR: _path.resolve(__dirname + '/../../'),
  PKGDIR: _path.resolve(__dirname, '/../../../../src/packages')
};

///////////////////////////////////////////////////////////////////////////////
// LOADERS
///////////////////////////////////////////////////////////////////////////////

/*
 * Loads generated configuration file
 */
function loadConfiguration(opts) {
  Object.keys(opts).forEach((k) => {
    if ( typeof ENV[k] !== 'undefined' && typeof opts[k] !== 'undefined' ) {
      ENV[k] = opts[k];
    }
  });

  if ( opts.ROOT ) {
    ENV.ROOTDIR = opts.ROOT;
  }

  const path = _path.join(ENV.SERVERDIR, 'settings.json');

  const safeWords = [
    '%VERSION%',
    '%DIST%',
    '%DROOT%',
    '%UID%',
    '%USERNAME%'
  ];

  function _read(data) {
    // Allow environmental variables to override certain internals in config
    data.match(/%([A-Z0-9_\-]+)%/g).filter((() => {
      let seen = {};
      return function(element, index, array) {
        return !(element in seen) && (seen[element] = 1);
      };
    })()).filter((w) => {
      return safeWords.indexOf(w) === -1;
    }).forEach((w) => {
      const p = w.replace(/%/g, '');
      const u = /^[A-Z]*$/.test(p);
      const v = u ? process.env[p] : null;
      if ( typeof v !== 'undefined' && v !== null ) {
        const re = w.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, '$1');
        data = data.replace(new RegExp(re, 'g'), String(v));
      }
    });

    const config = Object.assign({
      api: {},
      vfs: {},
      http: {},
      mimes: {},
      proxies: {},
      modules: {}
    }, JSON.parse(data));

    if ( process.env.SECRET ) {
      config.http.session.secret = process.env.SECRET;
    }
    if ( opts.CONNECTION || process.env.CONNECTION ) {
      config.http.connection = opts.CONNECTION || process.env.CONNECTION;
    }

    config.modules.auth = config.modules.auth || {};
    config.modules.storage = config.modules.storage || {};

    return Object.freeze(config);
  }

  function _load(resolve, reject) {
    _fs.readFile(path, (err, file) => {
      if ( err ) {
        return reject(err);
      }

      const config = _read(file.toString());

      CONFIG = Object.assign({}, config);
      if ( !ENV.PORT && config.http.port ) {
        ENV.PORT = config.http.port;
      }

      if ( typeof opts.LOGLEVEL === 'number' ) {
        ENV.LOGLEVEL = opts.LOGLEVEL;
      } else if ( typeof config.logging === 'number' ) {
        ENV.LOGLEVEL = config.logging;
      }

      ENV.PKGDIR = opts.PKGDIR || _path.join(ENV.ROOTDIR, 'src/packages');
      LOGGER = _osjs.logger.create(ENV.LOGLEVEL);

      Object.keys(config.proxies).forEach((k) => {
        LOGGER.lognt('INFO', 'Using:', LOGGER.colored('Proxy', 'bold'), k);
      });

      resolve(opts);
    });
  }

  return new Promise(_load);
}

/*
 * Loads and registers all Middleware
 */
function loadMiddleware(opts) {
  const dirname = _path.join(ENV.MODULEDIR, 'middleware');

  return new Promise((resolve, reject) => {
    _glob(_path.join(dirname, '*.js')).then((list) => {
      Promise.all(list.map((path) => {
        LOGGER.lognt('INFO', 'Loading:', LOGGER.colored('Middleware', 'bold'), path.replace(ENV.ROOTDIR, ''));

        try {
          MODULES.MIDDLEWARE.push(require(path));
        } catch ( e ) {
          LOGGER.lognt('WARN', LOGGER.colored('Warning:', 'yellow'), e);
          console.warn(e.stack);
        }

        return Promise.resolve(opts);
      })).then(() => {
        resolve(opts);
      }).catch(reject);
    }).catch(reject);
  });
}

/*
 * Loads and registers session module
 */
function loadSession(opts) {
  const dirname = _path.join(ENV.MODULEDIR, 'session');
  const name = opts.SESSION || (CONFIG.http.session.module || 'memory');

  return new Promise((resolve, reject) => {
    const path = _path.join(dirname, name + '.js');

    LOGGER.lognt('INFO', 'Loading:', LOGGER.colored('Session', 'bold'), path.replace(ENV.ROOTDIR, ''));

    try {
      MODULES.SESSION = require(path);
      resolve(opts);
    } catch ( e ) {
      reject(e);
    }
  });
}

/*
 * Loads and registers all API methods
 */
function loadAPI(opts) {
  const dirname = _path.join(ENV.MODULEDIR, 'api');

  return new Promise((resolve, reject) => {
    _glob(_path.join(dirname, '*.js')).then((list) => {
      Promise.all(list.map((path) => {
        LOGGER.lognt('INFO', 'Loading:', LOGGER.colored('API', 'bold'), path.replace(ENV.ROOTDIR, ''));

        const methods = require(path);
        Object.keys(methods).forEach((k) => {
          MODULES.API[k] = methods[k];
        });

        return Promise.resolve(opts);
      })).then(() => {
        resolve(opts);
      }).catch(reject);
    }).catch(reject);
  });
}

/*
 * Loads and registers Authentication module(s)
 */
function loadAuth(opts) {
  const name = opts.AUTH || (CONFIG.http.authenticator || 'demo');

  function _load(resolve, reject) {
    const path = _path.join(ENV.MODULEDIR, 'auth/' + name + '.js');
    LOGGER.lognt('INFO', 'Loading:', LOGGER.colored('Authenticator', 'bold'), path.replace(ENV.ROOTDIR, ''));

    try {
      const a = require(path);
      const c = CONFIG.modules.auth[name] || {};
      const r = a.register(c);

      MODULES.AUTH = a;

      if ( r instanceof Promise ) {
        r.then(() => {
          resolve(opts);
        }).catch(reject);
      } else {
        resolve(opts);
      }
    } catch ( e ) {
      LOGGER.lognt('WARN', LOGGER.colored('Warning:', 'yellow'), e);
      console.warn(e.stack);
      reject(e);
    }
  }

  return new Promise(_load);
}

/*
 * Loads and registers Storage module(s)
 */
function loadStorage(opts) {
  const name = opts.STORAGE || (CONFIG.http.storage || 'demo');

  function _load(resolve, reject) {
    const path = _path.join(ENV.MODULEDIR, 'storage/' + name + '.js');
    LOGGER.lognt('INFO', 'Loading:', LOGGER.colored('Storage', 'bold'), path.replace(ENV.ROOTDIR, ''));

    try {
      const a = require(path);
      const c = CONFIG.modules.storage[name] || {};
      const r = a.register(c);
      MODULES.STORAGE = a;

      if ( r instanceof Promise ) {
        r.then(resolve).catch(reject);
      } else {
        resolve();
      }
    } catch ( e ) {
      LOGGER.lognt('WARN', LOGGER.colored('Warning:', 'yellow'), e);
      console.warn(e.stack);
      reject(e);
    }
  }

  return new Promise(_load);
}

/*
 * Loads and registers VFS module(s)
 */
function loadVFS() {
  const dirname = _path.join(ENV.MODULEDIR, 'vfs');

  function _load(resolve, reject) {
    _fs.readdir(dirname, (err, list) => {
      if ( err ) {
        return reject(err);
      }

      _osjs.utils.iterate(list, (filename, index, next) => {
        if ( ['.', '_'].indexOf(filename.substr(0, 1)) === -1 ) {
          const path = _path.join(dirname, filename);
          LOGGER.lognt('INFO', 'Loading:', LOGGER.colored('VFS Transport', 'bold'), path.replace(ENV.ROOTDIR, ''));
          try {
            MODULES.VFS.push(require(path));
          } catch ( e ) {
            LOGGER.lognt('WARN', LOGGER.colored('Warning:', 'yellow'), e);
            console.warn(e.stack);
          }
        }
        next();
      }, resolve);
    });
  }

  return new Promise(_load);
}

/*
 * Loads generated package manifest
 */
function registerPackages(servers) {
  const path = _path.join(ENV.SERVERDIR, 'packages.json');
  LOGGER.lognt('INFO', 'Loading:', LOGGER.colored('Configuration', 'bold'), path.replace(ENV.ROOTDIR, ''));

  function _createOldInstance(env) {
    return {
      request: null,
      response: null,
      config: CONFIG,
      handler: null,
      logger: LOGGER
    };
  }

  function _registerApplication(name, packages, module) {
    if ( typeof module.api === 'object' ) {
      if ( typeof module.register === 'function' ) {
        module.register(ENV, packages[name], {
          http: servers.httpServer,
          ws: servers.websocketServer,
          proxy: servers.proxyServer
        });
      }
      return false;
    } else if ( typeof module._onServerStart === 'function' ) {
      // Backward compatible with old API
      module._onServerStart(servers.httpServer, _createOldInstance(ENV), packages[path]);
      return true;
    }

    return typeof module.api === 'undefined';
  }

  function _registerExtension(module) {
    if ( typeof module.api === 'object' ) {
      Object.keys(module.api).forEach((k) => {
        MODULES.API[k] = module.api[k];
      });

      return false;
    } else if ( typeof module.register === 'function' ) {
      // Backward compatible with old API
      let backAPI = {};
      module.register(backAPI, {}, _createOldInstance());

      Object.keys(backAPI).forEach((k) => {
        MODULES.API[k] = function(http, resolve, reject, args) {
          backAPI[k](_createOldInstance(), args, (err, res) => {
            if ( err ) {
              reject(err);
            } else {
              resolve(res);
            }
          });
        };
      });
    }
    return true;
  }

  function _launchSpawners(pn, module, metadata) {
    if ( metadata.spawn && metadata.spawn.enabled ) {
      const spawner = _path.join(ENV.PKGDIR, pn, metadata.spawn.exec);
      LOGGER.lognt('INFO', 'Launching', LOGGER.colored('Spawner', 'bold'), spawner.replace(ENV.ROOTDIR, ''));
      CHILDREN.push(_child.fork(spawner, [], {
        stdio: 'pipe'
      }));
    }
  }

  function _load(resolve, reject) {
    _fs.readJson(path, (err, manifest) => {
      if ( err ) {
        return reject(err);
      }

      const packages = manifest[ENV.DIST];

      Object.keys(packages).forEach((p) => {
        const metadata = packages[p];

        let filename = 'api.js';
        if ( metadata.build && metadata.build.index ) {
          filename = _path.resolve(metadata.build.index);
        }

        metadata._indexFile = filename;

        const check = _path.join(ENV.PKGDIR, p, filename);
        if ( metadata.enabled !== false && _fs.existsSync(check) ) {
          let deprecated = false;
          if ( metadata.type === 'extension' ) {
            LOGGER.lognt('INFO', 'Loading:', LOGGER.colored('Extension', 'bold'), check.replace(ENV.ROOTDIR, ''));
            deprecated = _registerExtension(require(check));
            _launchSpawners(p, module, metadata);
          } else {
            LOGGER.lognt('INFO', 'Loading:', LOGGER.colored('Application', 'bold'), check.replace(ENV.ROOTDIR, ''));
            deprecated = _registerApplication(p, packages, require(check));
          }

          if ( deprecated ) {
            LOGGER.lognt('WARN', LOGGER.colored('Warning:', 'yellow'), p, LOGGER.colored('is using the deprecated Application API(s)', 'bold'));
          }
        }
      });

      PACKAGES = Object.freeze(packages);

      resolve(servers);
    });
  }

  return new Promise(_load);
}

/*
 * Registers Services
 */
function registerServices(servers) {
  const dirname = _path.join(ENV.MODULEDIR, 'services');

  return new Promise((resolve, reject) => {
    _glob(_path.join(dirname, '*.js')).then((list) => {
      Promise.all(list.map((path) => {
        LOGGER.lognt('INFO', 'Loading:', LOGGER.colored('Service', 'bold'), path.replace(ENV.ROOTDIR, ''));
        try {
          const p = require(path).register(ENV, CONFIG, servers);
          if ( p instanceof Promise ) {
            return p;
          }
        } catch ( e ) {
          LOGGER.lognt('WARN', LOGGER.colored('Warning:', 'yellow'), e);
          console.warn(e.stack);
        }
        return Promise.resolve();
      })).then(resolve).catch(reject);
    }).catch(reject);
  });
}

/*
 * Sends the destruction signals to all Packages
 */
function destroyPackages() {
  return new Promise((resolve, reject) => {
    const queue = Object.keys(PACKAGES).map((path) => {
      const check = _path.join(ENV.PKGDIR, path, 'api.js');
      if ( _fs.existsSync(check) ) {
        try {
          const mod = require(check);

          LOGGER.lognt('VERBOSE', 'Destroying:', LOGGER.colored('Package', 'bold'), check.replace(ENV.ROOTDIR, ''));
          if ( typeof mod.destroy === 'function' ) {
            const res = mod.destroy();
            return res instanceof Promise ? res : Promise.resolve();
          }
        } catch ( e ) {
          LOGGER.lognt('WARN', LOGGER.colored('Warning:', 'yellow'), e);
          console.warn(e.stack);
        }
      }

      return Promise.resolve();
    });

    Promise.all(queue).then(resolve).catch(reject);
  });
}

/*
 * Sends the destruction signal to all Services
 */
function destroyServices() {
  const dirname = _path.join(ENV.MODULEDIR, 'services');

  return new Promise((resolve, reject) => {
    _glob(_path.join(dirname, '*.js')).then((list) => {
      Promise.all(list.map((path) => {
        LOGGER.lognt('VERBOSE', 'Destroying:', LOGGER.colored('Service', 'bold'), path.replace(ENV.ROOTDIR, ''));
        try {
          const res = require(path).destroy();
          return res instanceof Promise ? res : Promise.resolve();
        } catch ( e ) {
          LOGGER.lognt('WARN', LOGGER.colored('Warning:', 'yellow'), e);
          console.warn(e.stack);
        }
        return Promise.resolve();
      })).then(resolve).catch(reject);
    }).catch(reject);
  });
}

///////////////////////////////////////////////////////////////////////////////
// EXPORTS
///////////////////////////////////////////////////////////////////////////////

/**
 * Destroys the current instance
 *
 * @param {Function}    [cb]      Callback
 *
 * @function destroy
 * @memberof core.instance
 */
module.exports.destroy = (() => {
  let destroyed = false;

  return function destroy(cb) {
    cb = cb || function() {};

    if ( destroyed ) {
      return cb();
    }

    LOGGER.log('INFO', LOGGER.colored('Trying to shut down sanely...', 'bold'));

    function done() {
      CHILDREN.forEach((c) => {
        c.kill();
      });

      if ( MODULES.AUTH ) {
        MODULES.AUTH.destroy();
      }

      if ( MODULES.STORAGE ) {
        MODULES.STORAGE.destroy();
      }

      _osjs.http.destroy((err) => {
        destroyed = true;

        cb(err);
      });
    }

    destroyServices()
      .then(destroyPackages())
      .then(done).catch(done);
  };
})();

/**
 * Initializes OS.js Server
 *
 * @param   {ServerOptions}   opts           Server Options
 *
 * @function init
 * @memberof core.instance
 * @return {Promise}
 */
module.exports.init = function init(opts) {
  return new Promise((resolve, reject) => {
    loadConfiguration(opts)
      .then(loadMiddleware)
      .then(loadSession)
      .then(loadAPI)
      .then(loadAuth)
      .then(loadStorage)
      .then(loadVFS)
      .then(() => {
        return _osjs.http.init(ENV);
      })
      .then(registerPackages)
      .then(registerServices)
      .then((servers) => {
        resolve(Object.freeze(ENV));
      })
      .catch(reject);
  });
};

/**
 * Runs the OS.js Server
 *
 * @param   {Number}    [port]      Port number to start on
 *
 * @function run
 * @memberof core.instance
 * @return {Promise}
 */
module.exports.run = function run(port) {
  const httpConfig = Object.assign({ws: {}}, CONFIG.http || {});

  LOGGER.log('INFO', LOGGER.colored('Starting OS.js server', 'green'));
  LOGGER.log('INFO', LOGGER.colored(['Using', ENV.DIST].join(' '), 'green'));
  LOGGER.log('INFO', LOGGER.colored(['Running', httpConfig.mode, 'on localhost:' + ENV.PORT].join(' '), 'green'));

  if ( httpConfig.connection === 'ws' ) {
    const wsp = httpConfig.ws.port === 'upgrade' ? ENV.PORT : httpConfig.ws.port;
    const msg = ['Running ws', 'on localhost:' + wsp + (httpConfig.ws.path || '')];
    LOGGER.log('INFO', LOGGER.colored(msg.join(' '), 'green'));
  }

  const result = _osjs.http.run(ENV.PORT);
  LOGGER.log('INFO', LOGGER.colored('Ready...', 'green'));

  return result;
};

/**
 * Gets the `ENV` object
 *
 * @function getEnvironment
 * @memberof core.instance
 * @return {ServerEnvironment}
 */
module.exports.getEnvironment = function() {
  return Object.freeze(ENV);
};

/**
 * Gets the `Authenticator`
 *
 * @function getAuthenticator
 * @memberof core.instance
 * @return {Object}
 */
module.exports.getAuth = function() {
  return MODULES.AUTH;
};

/**
 * Gets the `Storage`
 *
 * @function getStorage
 * @memberof core.instance
 * @return {Object}
 */
module.exports.getStorage = function() {
  return MODULES.STORAGE;
};

/**
 * Gets the `Config`
 *
 * @function getConfig
 * @memberof core.instance
 * @return {Object}
 */
module.exports.getConfig = function() {
  return Object.freeze(CONFIG);
};

/**
 * Gets the `Logger"
 *
 * @function getLogger
 * @memberof core.instance
 * @return {Object}
 */
module.exports.getLogger = function() {
  return LOGGER;
};

/**
 * Gets all the registered VFS modules
 *
 * @function getVFS
 * @memberof core.instance
 * @return {Array}
 */
module.exports.getVFS = function() {
  return MODULES.VFS;
};

/**
 * Gets registered Session module
 *
 * @function getSession
 * @memberof core.instance
 * @return {Object}
 */
module.exports.getSession = function() {
  return MODULES.SESSION;
};

/**
 * Gets all the registered API methods
 *
 * @function getAPI
 * @memberof core.instance
 * @return {Object}
 */
module.exports.getAPI = function() {
  return MODULES.API;
};

/**
 * Gets all the registered Middleware modules
 *
 * @function getMiddleware
 * @memberof core.instance
 * @return {Array}
 */
module.exports.getMiddleware = function() {
  return MODULES.MIDDLEWARE;
};

/**
 * Gets metadata for package(s)
 *
 * @param {String}    packageName     Package Name ("DISTO/PACKAGE")
 *
 * @function getMetadata
 * @memberof core.instance
 * @return {Object}
 */
module.exports.getMetadata = function(packageName) {
  return packageName ? PACKAGES[packageName] : PACKAGES;
};
