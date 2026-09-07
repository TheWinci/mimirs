function picked() {
  return "picked";
}

function other() {
  return "other";
}

function inline() {
  return "unrelated top-level function";
}

module.exports = {
  picked,
  alias: other,
  inline() {
    return "inline object method";
  },
};
