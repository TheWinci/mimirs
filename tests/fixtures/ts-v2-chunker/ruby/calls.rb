class Worker
  def self.create = new()
end

def run(service)
  service.call()
  service&.execute(1)
  Worker.create()
  Worker::create()
  factory().build()
end
