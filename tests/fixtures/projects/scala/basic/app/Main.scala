package app

import project.Tools
import project.{Job as Work}
import project.Tools.run as execute
import project.*

object Main:
  def launch(): Unit =
    Tools.run()
    execute()
    new Work()
    Local.start()
    Missing.run()
