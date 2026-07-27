require "project/worker"
require_relative "../lib/helper"

Project::Worker.run
Helper.start
Project::Worker.new
Project::Worker.missing
