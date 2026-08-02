(function () {
  function create(defaults) {
    var state = Object.assign({}, defaults || {});
    return {
      get: function (key) {
        return state[key];
      },
      set: function (key, value) {
        state[key] = value;
        return value;
      },
      patch: function (patch) {
        Object.keys(patch || {}).forEach(function (key) {
          state[key] = patch[key];
        });
        return Object.assign({}, state);
      },
      snapshot: function () {
        return Object.assign({}, state);
      },
    };
  }

  window.AiIntakeState = { create: create };
})();