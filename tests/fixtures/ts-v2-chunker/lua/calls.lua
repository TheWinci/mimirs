local function build()
  return make()
end

local callable = build()

run()
service:execute(value)
module.helper(value)
build()()
consume { value = load() }
print "hello"
