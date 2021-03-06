(function(L) {
  'use strict';
  /**
   * The log event.
   *
   * @param{Object} object The initial attributes of this log event.
   **/
  L.models.LogEvent = Backbone.Model.extend({
    urlRoot: '/logentries',
    defaults: function() {
      return {
        time: Date.now()
      };
    },
    initialize: function() {
      this.on('error', function(model, e, o) {
        error("Error syncing log entry", model, e, o);

        /* If we fail on load, just remove the entry. It's a log entry so we
         * really don't care that much.
         *
         * Log entries can go missing because their save (or the Logger's save)
         * may be delayed.
         */
        if (o.fetching) {
          model.destroy();
        }
      });
    },
    initialized: function() {
      var that = this;
      if (this.isNew()) {
        L.gvent.trigger('log:request:data', this);
      }
      var debouncedSave = _.debounce(_.bind(this.save, this), 100);
      this.listenTo(this, "change", function(m) {
        if (!that.isNew()) {
          debouncedSave();
        }
      });
    },
    validate: function(attrs, options) {
      if (typeof(attrs.action) !== 'string'){
        return "Undefined action";
      }
    }
  });

  /**
   * The actual log collection. Never used by itself.
   **/
  L.models.Log = Backbone.Collection.extend({
    model: L.models.LogEvent,
    initialize: function() {
      this.on('invalid', function(model, e) {
        debug(e, model);
      });
    },
    clearUntil: function(time) {
      this.chain()
      .filter(function(e) {
        return e.get('time') <= time;
      })
      .each(function(e) {
        e.destroy();
      });
    }
  });

  /**
   * The logger model.
   *
   * A singleton.
   *
   **/
  L.models.Logger = Backbone.RelModel.extend({
    url: '/log',
    autoFetch: true,
    autoFetchRelated: true,
    relations: {
      log: {
        type: L.models.Log,
        includeInJSON: "id"
      }
    },
    isNew: function() {
      return false;
    },
    initialize: function(models, options) {
      var that = this;
      // Call destructors on exit
      this.listenTo(L.gvent, 'sys:exit', _.bind(this.stop, this));
      this.once('sync error', function() {
        var debouncedSave = _.debounce(_.bind(that.save, that), 10);
        // Perform an initial flush to save any changes that might have occured
        // durring fetch.
        that.save();
        _.each(that.relations, function(v, k) {
          that.listenTo(that.get(k), 'add remove', function(model, collection, options) {
            if (!(options && options.nosave)) {
              debouncedSave();
            }
          });
        });
      });
    },
    /**
     * Start logging
     *
     * Starts the logging observers.
     **/
    start: function() {
      if (this._started) {
        return;
      }
      this.observers = _.chain(
        L.observers
      ).filter(function(obs) {
        return _.result(obs, "condition");
      }).map(function(obs) {
        var Ctor = function() {};
        Ctor.prototype = obs;
        var inst = new Ctor();
        inst.setup();
        return inst;
      });
    },
    /**
     * Stop logging
     *
     * Stops the logging observers.
     **/
    stop: function() {
      _.each(this.observers, function(inst) {
        inst.destroy();
      });
      delete this.observers;
    },
    /**
     * Clear log events before and including time.
     **/
    clearUntil: function(/* time */) {
      var log = this.get('log');
      return log.clearUntil.apply(log, arguments);
    },
    /**
     * Add the passed LogEvent model to the log and save it.
     *
     * @see Backbone.Collection#create
     **/
    create: function(/* model, [options] */) {
      var log = this.get('log');
      return log.create.apply(log, arguments);
    }
  });
})(ListIt);
