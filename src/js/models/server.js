(function(L) {
    'use strict';
    // Handles syncing notes with the server.
    // Do not persist
    L.models.Server = Backbone.Model.extend({
        defaults : {
            url: 'https://welist.it/listit/jv3/',
            syncing: false,
            syncingLogs: false,

            noteSyncInterval: 10*60*1000, // 10m
            //logSyncInterval:  30*60*1000, // 30m
            logSyncInterval:  -1 // Disabled
        },
        initialize: function() {
            _.bindAll(this);
            L.vent.on('user:sync', this.syncNotes);
        },
        // Defines a translation between a packaged note and a local note.
        transTable : {
            'jid': { here: 'id' },
            'version': {},
            'created': {},
            'edited': {},
            'contents': {},
            'meta': { transIn: JSON.parse, transOut: JSON.stringify },
            'modified': {
                transIn: function(v) { return v !== 0; },
                transOut: function(v) { return v ? 1 : 0; }
            }
        },
        // Make an ajax method call
        ajax : function(options) {
            options = _.clone(options);

            if (options.continuation) {
                var continuation = options.continuation;
                options.success = function(data) {
                    continuation(true, data);
                };
                if (!options.error) {
                    options.error = function(xhdr, stat) {
                        continuation(false, stat);
                    };
                }
                delete options.continuation;
            }

            // Call with auth token if needed. Do it this way to allow for
            // asynchronous authentication (password prompts etc.)
            if (options.auth && !options.authToken) {
                var that = this;
                L.authmanager.getToken(function(token) {
                    if (token) {
                        options.authToken = token;
                        that.ajax(options);
                    } else {
                        (options.error || $.noop)(null, 'Failed to authenticate');
                        (options.complete || $.noop)();
                    }
                });
                return;
            }

            if (!options.type) {
                options.type = options.data ? 'POST' : 'GET';
            }

            options.url = this.get('url') + options.method +
              (options.type === 'POST' ? '/' : '') +
                (options.auth ? ('?HTTP_AUTHORIZATION=' + options.authToken) : '');

            options.crossDomain = true;
            $.ajax(options);
        },
        syncNotes : function() {
          if (this._syncNotesEnter()) {
            var that = this;
            this.pullNotes({
                error: that._syncNotesFailure,
                success: function() {
                  that.pushNotes({
                    error: that._syncNotesFailure,
                    success: that._syncNotesSuccess
                  });
                }
            });
          }
        },
        _syncNotesEnter: function() {
          // Don't sync if waiting for a past sync.
          if (this.get('synching')) {
            return false;
          }
          clearTimeout(this.get('noteSyncTimer'));
          debug('syncNotes::start');

          this.trigger('sync:start');
          this.set('syncing', true);
          return true;
        },
        _syncNotesExit: function() {
          this.set('syncing', false);
          var interval = this.get('noteSyncInterval');
          if (interval > 0) {
            this.set('noteSyncTimer', window.setTimeout(this.syncNotes, interval));
          }
        },
        _syncNotesFailure: function(xhdr, stat) {
          debug('syncNotes::fail', stat);
          this.trigger('sync:failure', stat);
          this._syncNotesExit();
        },
        _syncNotesSuccess: function() {
          // Successful Ajax Response:
          this.trigger('sync:success');
          this._syncNotesExit();
        },
        pullNotes : function(options) {
          var that = this;
          this.ajax({
            method: 'notes',
            dataType: 'json',
            auth: true,
            success: function(results) {
              that.unbundleNotes(results);
              if (options.success) {
                options.success(results);
              }
            },
            error: options.error,
            complete: options.complete
          });
        },
        pushNotes : function(options) {
          var that = this;
          this.ajax({
              method: 'notespostmulti',
              dataType: 'json',
              auth: true,
              data: JSON.stringify(this.bundleNotes()),
              success: function(response) {
                that.commitNotes(response.committed);
                if (options.success) {
                  options.success();
                }
              },
              error: options.error,
              complete: options.complete
          });
        },
        syncLogs : function() {
            if (this.get('syncingLogs')) {
                return;
            }

            debug('syncLogs::start');
            var that = this;

            this.set('syncingLogs', true);
            this.ajax({
                method: 'post_json_chrome_logs',
                auth: true,
                data: L.logs.toJSON(),
                error: function() {
                    debug('FAIL: Logs not sent to server.');
                    debug('syncLogs::failed');
                    // TODO:Do something?
                },
                success: function() {
                    // TODO: Clear Logs
                    debug('Implement logging.');
                    debug('syncLogs::succeeded');
                },
                complete: function() {
                    that.set('syncingLogs', false);
                    var interval = that.get('logSyncInterval');
                    if (interval > 0) {
                        that.set('logSyncTimer', setTimeout(that.syncLogs, interval));
                    }
                }
            });
        },
        start : function() {
            // Note: use timout instead of interval for a responsive interface.
            // Also allows pre-empting

            var noteSyncInterval = this.get('noteSyncInterval', -1),
                logSyncInterval = this.get('logSyncInterval', -1);

            if (noteSyncInterval > 0) {
                this.syncNotes();
            }
            if (logSyncInterval > 0) {
                this.syncLogs();
            }
        },
        stop : function() {
            clearTimeout(this.get('noteSyncTimer'));
            clearTimeout(this.get('logSyncTimer'));
        },
        /**
        * Package and bundle the given notes.
        */
        bundleNotes : function() {
            var that = this,
                bundle = [],
                bundleNote = function(note, deleted) {
                    if (note.get('modified')) {
                        bundle.push(that.packageNote(note, deleted));
                    }
                };


            // Push magic note.
            //TODO: Avoid sending every time?
            bundle.push({
                'jid': -1,
                'version': L.notebook.get('version'),
                'created': 0,
                'edited': 0,
                'contents': JSON.stringify({noteorder:L.notebook.get('notes').getOrder()}),
                'deleted': 1
            });
            L.notebook.get('notes').each(function(n) { bundleNote(n, false); });
            L.notebook.get('deletedNotes').each(function(n) { bundleNote(n, true); });
            
            return bundle;
        },
        commitNotes: function(committed) {
          // For each
          _.chain(committed)
          // Ignore magic note
          .filter(function(note) {
            return note.jid >= 0;
          })
          // Check status
          .filter(function(note) {
            return (note.status === 201 || note.status === 200);
          })
          // Lookup note
          .pluck('jid')
          .map(L.notebook.getNote)
          .reject(_.isUndefined)
          .each(function(note) {
            // Set unmodified and increment version (server does the same).
            note.set({
              modified: false,
              version: note.get('version') + 1
            });
            note.save();
          });
          // Update note collection version.
          L.notebook.set('version', L.notebook.get('version') + 1);
        },
        unbundleNotes: function(result) {
            var order;
            // Update changed
            _.chain(result)
            .pluck("fields")
            .map(this.unpackageNote)
            .filter(function(n) { // Filter out magic note.
                if (n.id < 0) {
                  if (L.notebook.get('version') < n.version) {
                    order = JSON.parse(n.contents);
                  }
                  return false;
                } else {
                    return true;
                }
            })
            .each(function(n) {
              var deleted = _.pop(n, 'deleted');
              var note = L.notebook.getNote(n.id);
              if (note) {
                if (note.get('version') < n.version) {
                  if (note.get('modified')) {
                    note.merge(n);
                    // On merge, only undelete (safest)
                    if (!deleted) {
                      note.moveTo(L.notebook.get('notes'), {nosave: true});
                    }
                  } else {
                    note.set(n);
                    // delete/undelete based on latest version.
                    note.moveTo(L.notebook.get(deleted ? 'deletedNotes' : 'notes'), {nosave: true});
                  }
                  note.save();
                }
              } else {
                L.notebook.get(deleted ? 'deletedNotes' : 'notes').create(n, {nosave: true});
              }
            });
            
            // FIXME: don't necessarily clobber order.
            if (order) {
              L.notebook.get('notes').setOrder(order);
            }

            // Save collections
            L.notebook.save();

            // Successful Ajax Response:
            this.trigger('sync:success');
        },

        /**
        * Convert a note into a package that can be sent to the server.
        */
        packageNote : function(note, deleted) {
            var meta = note.get('meta'),
                packed = {deleted: deleted ? 1 : 0};

            _(this.transTable).each(function(trans, field) {
                packed[field] = note.get(trans.here || field);
                if (trans.transOut) {
                    packed[field] = trans.transOut(packed[field]);
                }
            });
            return packed;
        },
        /**
        * Convert a package from the server into a hash of fields that can be used to update/create a note.
        */
        unpackageNote : function(note) {
            var unpacked = {modified: false, deleted: note.deleted !== 0};
            _(this.transTable).each(function(trans, field) {
                if (!note.hasOwnProperty(field)) {
                    return;
                }
                var myField = trans.here || field;
                unpacked[myField] = note[field];
                if (trans.transIn) {
                    unpacked[myField] = trans.transIn(unpacked[myField]);
                }
            });
            return unpacked;
        },
        validateUser: function(hashPass, options) {
            debug('logging in:', hashPass);
            this.ajax(_.extend({
                method: 'login',
                auth: 'true',
                cache: false,
                authToken: hashPass
            }, options));
        },
        registerUser : function(email, password, couhes, options) {
            // Pulled from zen/tags site
            var firstname = '';
            var lastname = '';

            this.ajax(_.extend({
                method: 'createuser',
                data: {
                    username: email,
                    password: password,
                    couhes: couhes,
                    firstname: firstname,
                    lastname: lastname
                },
                cache: false
            }, options));
        }
    });

    // This manages account information.
    // It doesn't have a view, it doesn't do anything but store the auth token.
    L.models.AuthManager = Backbone.Model.extend({
        initialize: function() {
            this.fetch();
            this.listenTo(this, 'change', _.mask(this.save));
        },

        // Singleton
        url: '/authmanager',
        isNew: function() {return false;},
        /**
        * Call the callback with the auth token.
        *
        * This method must be defined.
        */
        getToken: function(callback) {
            callback(this.get('hashpass', null));
        },
        /**
        * Set the auth token.
        *
        * This method doesn't only needs to be made available to the authentication agent.
        */
        setToken: function(token) {
            this.set('hashpass', token);
        },
        unsetToken: function() {
            this.unset('hashpass');
        }
    });
})(ListIt);