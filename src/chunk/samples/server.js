"use strict";

const path = require("path");
const { readFile } = require("fs/promises");

/** Port the server listens on. */
const PORT = 3000;

class Router {
  routes = new Map();

  handleRequest = (request, response) => {
    const route = this.routes.get(request.url);
    route(request, response);
  };

  add(url, handler) {
    this.routes.set(url, handler);
  }
}

function serveFile(file) {
  return readFile(path.join(__dirname, file));
}

module.exports.serveFile = function (file) {
  return serveFile(file);
};

module.exports = { Router, PORT };
