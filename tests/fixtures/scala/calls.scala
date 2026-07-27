object Calls:
  def run(loader: () => String, service: Service, head: String, items: List[String]): Unit =
    loader()
    helper(1)(2)
    service.execute()
    Type.create[String]()
    items map process
    head :: items
    new Worker(build())
    summon[Ordering[String]]

  def helper(first: Int)(second: Int): Int = first + second

class Worker(value: String)
