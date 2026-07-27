class Scope
  def run(loader)
    loader.call()
    helper()
    callback.call()

    callback = -> { perform() }
  end

  def helper
  end

  def duplicate(value)
  end

  def duplicate(value, options = {})
  end
end
