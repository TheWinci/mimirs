require "real"
require_relative "support/local"
load "config/setup.rb"
autoload :Worker, "workers/worker.rb"

def shadowed(require)
  require("parameter.rb")
end

class Loader
  def require(feature)
    feature
  end

  def run
    require("method.rb")
  end
end

require "after-class"
