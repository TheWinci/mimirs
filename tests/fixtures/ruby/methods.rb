class Processor
  def run(value = fallback(), prefix:, **options, &callback)
    helper(value)
    callback.call(value)
    yield value
    super()
  end

  def helper(value)
    clean(value)
  end

  def self.build = new()

  def [](key) = fetch(key)
  def ready? = check()
  def save! = persist()
end
