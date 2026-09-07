require "json"
require("set")
require_relative "support/worker"
require "feature/#{name}"

def load_dependencies(loader, name)
  require name
  loader.require("plugin")
  load "setup.rb"
end
