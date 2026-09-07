class worker = object
  method run value = process value
end

let execute service value = service#run value
let create () = new worker
